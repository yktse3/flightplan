const moment = require('moment-timezone')

const Searcher = require('../../Searcher')
const { cabins } = require('../../consts')
const logger = require('../../../shared/logger')

const { errors } = Searcher

function addslashes(str) {
  return (str + '').replace(/[\]\[\.]/g, '\\\\$&').replace(/\u0000/g, '\\\0');
}

module.exports = class extends Searcher {
  async isLoggedIn (page) {
    // Sometimes the page keeps reloading out from under us
    return this.retry(async () => {
      try {
        await page.waitFor('li.member-login-section, li.member-section', { visible: true })
      } catch (err) {}
      return !!(await page.$('li.member-section'))
    })
  }

  async login (page, credentials) {
    const [ username, password ] = credentials
    if (!username || !password) {
      throw new errors.MissingCredentials()
    }

    // Enter username and password
    await this.enterText('#account-login #username', username)
    await this.enterText('#account-login #password', password)
    await page.waitFor(250)

    // Check remember box
    if (!await page.$('#account-login #checkRememberMe:checked')) {
      await page.click('#account-login label[for=checkRememberMe]')
      await page.waitFor(250)
    }

    // Submit form
    await this.clickAndWait('#account-login button.btn-primary')

    // Check for errors
    const msgError = await this.textContent('div.global-error-wrap li')
    if (msgError.includes('incorrect membership number or username')) {
      throw new errors.InvalidCredentials()
    } else if (msgError.includes('reactivate your account')) {
      throw new errors.BlockedAccount()
    }
    if (await page.$('#captcha-container')) {
      throw new errors.BotDetected()
    }
  }

  async search (page, query, results) {
    const { oneWay, fromCity, toCity, cabin, quantity } = query
    const departDate = query.departDateMoment()
    const returnDate = query.returnDateMoment()

    // Make sure destination city is cleared
    await this.clearCity('input[name="segments[0].destination"]')

    // Set from / to cities
    await this.setCity('input[name="segments[0].origin"]', '#react-autowhatever-segments\\[0\\]\\.origin', fromCity)
    await this.setCity('input[name="segments[0].destination"]', '#react-autowhatever-segments\\[0\\]\\.destination', toCity)

    // Set one-way / roundtrip
    await page.click(oneWay ? '#tab-tripType-ow span' : '#tab-tripType-rt span')
    await page.waitFor(500)

    // Set dates
    const dates = oneWay ? [departDate] : [departDate, returnDate]
    let selector = `div.travel-dates-${oneWay ? 'ow' : 'rt'}-wrapper`
    if (oneWay) {
      selector = '.ibered__form-dp-hit-test-container'
    }
    for (let i = 0; i < dates.length; i++) {
      // Check if calendar is visible
      try {
        await page.waitFor('.DayPicker_title', { visible: true, timeout: 2000 })
      } catch (err) {
        // Don't see calendar, open it up
        if (oneWay) {
          await page.click(selector)
        } else {
          await page.click(`${selector} button:nth-of-type(${i + 1})`)
        }
      }

      // Choose the date
      await this.setDate(dates[i])
    }

    // Set the cabin
    try {
      await this.selectCabin(cabin)
    } catch (err) {
      console.error(err)
      throw new Searcher.Error(`Could not set cabin to: ${cabin}`)
    }

    // Set quantity
    await page.click('#numAdult\\,numChild-value')
    await page.waitFor('.ibered__form-pms-panel-inner-wrapper', { visible: true, timeout: 10000 })
    await page.waitFor(500)
    try {
      await this.selectAdultNumber(quantity)
    } catch (err) {
      console.error(err)
      throw new Searcher.Error(`Could not set # of adults to: ${quantity}`)
      await page.waitFor(1000000)
    }

    // Turn off flexible dates
    if (await page.$(`.ibered__form-checkbox-wrapper input:checked`)) {
      await page.click(`.ibered__form-checkbox-wrapper input:checked ~ label`)
      await page.waitFor(250)
    }

    // Get results
    await this.submitForm(results)
  }

  async submitForm (results) {
    const { page } = this
    const pageBom = []
    const milesInfo = []
    const json = {}

    let fn = null
    try {
      // Capture AJAX responses with pricing info
      fn = (response) => {
        if (response.url().includes('milesInfo')) {
          const contentLength = parseInt(response.headers()['content-length'])
          if (contentLength > 0) {
            response.json().then(x => {
              milesInfo.push(x)
            })
          }
        }
      }
      this.page.on('response', fn)

      // Submit search form
      const response = await Promise.race([
        this.clickAndWait('.ibered__search-form-submit'),
        this.page.waitFor('span.label-error', { visible: true, timeout: 0 })
      ])
      if (response && response.constructor.name !== 'ElementHandle') {
        this.checkResponse(response)
      }

      // Get results for each tier
      let idx = 0
      let tabs = null
      while (true) {
        // Make sure results have finished loading
        await this.settle()

        // Insert a small wait (to simulate throttling between tabs)
        await this.waitBetween(4000, 6000)

        // Check for error messages
        const msg = await this.textContent('span.label-error')
        if (msg.length > 0) {
          if (msg.includes('no flights available')) {
            json.noFlights = true
            break
          } else if (msg.includes('please login again')) {
            // If session becomes invalid, logout
            await this.logout()
          }
          throw new Searcher.Error(`Website returned error: ${msg}`)
        }

        // If there's a "No flights available" modal pop-up, dismiss it
        await this.clickIfVisible('#flights-not-available-modal button.btn-modal-close')

        // await this.page.waitFor('.flights-filter-button', { visible: true, timeout: 500 })
        // await this.page.click('.flights-filter-button')
        // await this.page.waitFor(250) 
        // await this.page.waitFor('#flights-departure-direct-only', { visible: true, timeout: 500 })
        // await this.page.click(`label[for=flights-departure-direct-only]`)
        // await this.page.click(`label[for=flights-departure-available-only]`)
        // await this.page.waitFor(250)
        // await this.page.waitFor(10000)

        // Obtain flight data
        pageBom.push(await page.evaluate(() => window.pageBom))

        // Take a screenshot
        await results.screenshot(`results-${idx}`)

        // Get the selectors of every tab, if not already done
        if (!tabs) {
          break;
          tabs = await this.findTabs()
          if (!tabs) {
            throw new Searcher.Error(`Failed to locate tab selectors`)
          }
        }
        if (tabs.length === 0) {
          break // No more tabs
        }
        const nextTab = tabs.shift()
        idx++

        // Make sure the tab is visible, then click it
        await this.scrollTab(nextTab)
        await page.click(nextTab)

        // Dismiss modal pop-up, warning us about changing award type
        await this.dismissWarning()
      }
    } finally {
      if (fn) {
        this.page.removeListener('response', fn)
      }
    }

    // Obtain JSON data from browser
    const tiers = await page.evaluate(() => {
      const { tiersListInbound, tiersListOutbound } = window
      return { tiersListInbound, tiersListOutbound }
    })
    if (tiers.tiersListInbound) {
      json.tiersListInbound = tiers.tiersListInbound
    }
    if (tiers.tiersListOutbound) {
      json.tiersListOutbound = tiers.tiersListOutbound
    }
    json.pageBom = pageBom
    json.milesInfo = milesInfo.reduce((result, curr) => ({ ...result, ...curr.milesInfo }), {})

    // Save results
    await results.saveJSON('results', json)
  }

  async logout () {
    const { page } = this

    // Logout if possible
    const memberSel = 'li.member-section'
    const logoutSel = `${memberSel} button.circle-link-arrow-btn`
    try {
      await page.waitFor(memberSel, { visible: true, timeout: 1000 })
      await page.hover(memberSel)
      await page.waitFor(logoutSel, { visible: true, timeout: 1000 })
      await this.clickAndWait(logoutSel)
    } catch (err) {}
  }

  async findTabs () {
    const { page } = this

    const tabs = await page.evaluate((queryCabin) => {
      const types = [ 'standard', 'choice', 'tailored' ]
      const all = [...document.querySelectorAll('#flightlistDept div.owl-item')]
        .map((item, idx) => {
          // Is the tab active?
          const active = !!item.querySelector('div.cabin-ticket-card-wrapper-outer.active')

          // Get the award type
          const type = item.querySelector('span.ticket-type').textContent.trim().toLowerCase()

          // Add the tab
          const sel = `div.owl-item:nth-of-type(${idx + 1}) div.cabin-ticket-card`
          return { sel, active, type }
        })

      // We only need one tab of each award type
      return types
        .map(type => all.find(x => x.type === type))
        .filter(x => !!x && !x.active)
        .map(x => x.sel)
    })

    return tabs
  }

  async scrollTab (sel) {
    const { page } = this
    const tabIndex = parseInt(/nth-of-type\((\d+)\)/.exec(sel)[1])

    // Scroll back to first tab
    while (true) {
      try {
        await page.waitFor('div.owl-prev', { visible: true, timeout: 1000 })
        await page.click('div.owl-prev')
      } catch (err) {
        break
      }
    }

    // Scroll forward to desired tab
    for (let i = 0; i < tabIndex - 2; i++) {
      try {
        await page.waitFor('div.owl-next', { visible: true, timeout: 1000 })
        await page.click('div.owl-next')
      } catch (err) {
        break
      }
    }
  }

  async dismissWarning () {
    const { page } = this

    // Warning modal present?
    try {
      await page.waitFor('#change-ticket-type-modal', { visible: true, timeout: 1000 })

      // Check the "Don't show again" box and dismiss
      if (await page.$('#change-ticket-type-dont-show-again:not(:checked)')) {
        await page.click('label[for=change-ticket-type-dont-show-again]')
        await page.waitFor(250)
      }
      await page.click('#change-ticket-type-modal button.btn-confirm')
    } catch (err) {}
  }

  async settle () {
    // Wait for spinner
    await this.monitor('.section-loading-overlay')
    await this.monitor('img.icon-loading')
  }

  async setCity (inputSel, selectSel, value) {
    const { page } = this
    await page.click(inputSel)
    await this.clear(inputSel)
    await page.waitFor(500)
    await page.keyboard.type(`(${value})`, { delay: 100 })
    const itemSel = `${selectSel}--item-0`
    await page.waitFor(itemSel, { visible: true, timeout: 10000 })
    await page.click(itemSel)
    await page.waitFor(500)
  }

  async clearCity (inputSel) {
    const { page } = this
    try {
      await page.waitFor(inputSel, { visible: true })
      await page.click(inputSel)
      await page.waitFor(500)
      await page.keyboard.press('Backspace')
      await page.waitFor(500)
    } catch (err) {}
  }

  async selectCabin(cabin) {
    const { page } = this;
    const cabinOptions = {
      [cabins.economy]: 0,
      [cabins.premium]: 1,
      [cabins.business]: 2,
      [cabins.first]: 3
    }
    let selectID = 2;
    if (await page.$('#searchHistory') !== null) {
      selectID = 5;
    }

    const optionSelector = `#react-select-${selectID}-option-${cabinOptions[cabin]}`;
    await page.click('#cabinClass')
    await page.waitFor(500)
    await page.waitFor('.react-select__menu', { visible: true })
    await page.waitFor(optionSelector, { visible: true, timeout: 10000 })
    await page.click(optionSelector)
    await page.waitFor(500)
  }

  async selectAdultNumber(quantity) {
    const { page } = this;
    await page.click('#numAdult')
    await page.waitFor(500)

    let inputID = await page.evaluate((sel) => {
      return document.querySelector(sel).id
    }, '#numAdult input')
    const inputIDSplitted = inputID.split('-');
    inputIDSplitted.splice(inputIDSplitted.length-1, 1);
    const optionSelector = `#${inputIDSplitted.join('-')}-option-${quantity-1}`;

    await page.waitFor('.react-select__menu', { visible: true, timeout: 10000 })
    await page.waitFor(optionSelector, { visible: true, timeout: 10000 })
    await page.click(optionSelector)
    await page.waitFor(500)
  }

  async setDate (date) {
    let ret, direction

    // Move through the calendar page-by-page
    while (true) {
      // Check if the desired date is displayed
      ret = await this.chooseDate(0, date)
      if (ret.error || ret.success) {
        return ret
      }
      const m1 = ret.month
      ret = await this.chooseDate(1, date)
      if (ret.error || ret.success) {
        return ret
      }
      const m2 = ret.month

      // Should move left?
      let btnSel
      if (date.isBefore(m1)) {
        btnSel = '.DayPickerNavigation_button_prev .ibered__icons-arrow-left'
      } else if (date.isSameOrAfter(m1.endOf('month')) || date.isAfter(m2.endOf('month'))) {
        btnSel = '.DayPickerNavigation_button_next .ibered__icons-arrow-right'
      }
      if (btnSel) {
        if (direction && btnSel !== direction) {
          throw new Searcher.Error(`Infinite loop detected searching calendar for date: ${date}`)
        }
        await this.changeMonth(btnSel, date)
        direction = btnSel
      } else {
        throw new Searcher.Error(`Did not find date on active calendar pages: ${date}`)
      }
    }
  }

  async chooseDate (whichCalendar, date) {
    const { page } = this

    // Parse out the month first
    let str = await page.evaluate((sel, whichCalendar) => {
      return document.querySelectorAll(sel)[whichCalendar].textContent
    }, '.CalendarMonthGrid_month__horizontal_1:not(.CalendarMonthGrid_month__hidden)', whichCalendar)
    str = str.replace(/\s+/, ' ').substr(0, 8);
    const month = moment.utc(str.replace(/\s+/, ' ').substr(0, 8), 'MMM YYYY', true)

    // Does the date belong to this month?
    if (date.month() !== month.month() || whichCalendar === 1) {
      return { month, success: false }
    }

    // Find the right day, and click it
    for (const elem of await page.$$('.CalendarMonthGrid_month__horizontal_1:not(.CalendarMonthGrid_month__hidden) td')) {
      const text = await page.evaluate(x => x.textContent, elem)
      const dateStr = `${text.replace(/\s+/, ' ')} ${str}`
      const elemDate = moment.utc(dateStr, 'D MMM YYYY', true)
      if (elemDate.isValid() && elemDate.date() === date.date()) {
        // Found the date, click it!
        await elem.click()
        await page.waitFor(500)
        return { month, success: true }
      }
    }

    throw new Searcher.Error(`Date link not found within selected month: ${date}`)
  }

  async changeMonth (selector, date) {
    const { page } = this

    // Check if the desired link is not present
    try {
      await page.waitFor(1000)
      await page.waitFor(selector, { visible: true, timeout: 5000 })
    } catch (err) {
      throw new Searcher.Error(`Failed to navigate calendar to date: ${date}`)
    }
    await page.click(selector)
    await page.waitFor(500)
  }
}
