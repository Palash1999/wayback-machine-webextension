// background.js
//
// License: AGPL-3
// Copyright 2016-2020, Internet Archive

// from 'utils.js'
/*   global isNotExcludedUrl, get_clean_url, isValidUrl, notify, openByWindowSetting, sleep, wmAvailabilityCheck, hostURL, isFirefox */
/*   global initDefaultOptions, afterAcceptOptions, viewableTimestamp, badgeCountText, getWaybackCount, newshosts */

var manifest = chrome.runtime.getManifest()
// Load version from Manifest.json file
var VERSION = manifest.version
// Used to store the statuscode of the if it is a httpFailCodes
var globalStatusCode = ''
let gToolbarStates = {}
let waybackCountCache = {}
let wikipediaBooksCache = new Map()
let tvNewsCache = new Map()
let tabIdPromise
var WB_API_URL = hostURL + 'wayback/available'

function rewriteUserAgentHeader(e) {
  for (var header of e.requestHeaders) {
    if (header.name.toLowerCase() === 'user-agent') {
      header.value = header.value + ' Wayback_Machine_Chrome/' + VERSION + ' Status-code/' + globalStatusCode
    }
  }
  return { requestHeaders: e.requestHeaders }
}

function URLopener(open_url, url, wmIsAvailable) {
  if (wmIsAvailable === true) {
    wmAvailabilityCheck(url, () => {
      openByWindowSetting(open_url)
    }, () => {
      if (isFirefox) {
        notify('This page has not been archived.')
      } else {
        alert('This page has not been archived.')
      }
    })
  } else {
    openByWindowSetting(open_url)
  }
}

/* * * API Calls * * */

function savePageNow(tabId, page_url, silent = false, options = []) {
  if (isValidUrl(page_url) && isNotExcludedUrl(page_url)) {
    const data = new URLSearchParams()
    data.append('url', encodeURI(page_url))
    options.forEach(opt => data.append(opt, '1'))
    const timeoutPromise = new Promise((resolve, reject) => {
      setTimeout(() => {
        reject(new Error('timeout'))
      }, 30000)
      fetch(hostURL + 'save/',
        {
          credentials: 'include',
          method: 'POST',
          body: data,
          headers: {
            'Accept': 'application/json'
          }
        })
      .then(resolve, reject)
    })
    return timeoutPromise
      .then(response => response.json())
      .then((res) => {
        if (!silent) {
          notify('Saving ' + page_url)
          chrome.storage.local.get(['show_resource_list'], (result) => {
            if (result.show_resource_list === true) {
              const resource_list_url = chrome.runtime.getURL('resource_list.html') + '?url=' + page_url + '&job_id=' + res.job_id + '#not_refreshed'
              openByWindowSetting(resource_list_url, 'windows')
            }
          })
        }
        if (('job_id' in res) && (res.job_id !== 'undefined')) {
          validate_spn(tabId, res.job_id, silent, page_url)
        } else {
          // handle error
          let msg = res.message || 'Please Try Again'
          chrome.runtime.sendMessage({ message: 'save_error', error: msg })
          if (!silent) {
            notify('Error: ' + msg)
          }
        }
      })
  }
}

function auth_check() {
  const timeoutPromise = new Promise((resolve, reject) => {
    setTimeout(() => {
      reject(new Error('timeout'))
    }, 30000)
    fetch(hostURL + 'save/',
      {
        credentials: 'include',
        method: 'POST',
        headers: {
          'Accept': 'application/json'
        }
      })
    .then(resolve, reject)
  })
  return timeoutPromise
  .then(response => response.json())
}

async function validate_spn(tabId, job_id, silent = false, page_url) {
  let vdata
  let status = 'start'
  const val_data = new URLSearchParams()
  val_data.append('job_id', job_id)

  while ((status === 'start') || (status === 'pending')) {
    // update UI
    chrome.runtime.sendMessage({
      message: 'save_start',
      tabId: tabId
    })
    if (status === 'pending') {
      addToolbarState(tabId, 'S')
    }

    await sleep(6000)
    const timeoutPromise = new Promise((resolve, reject) => {
      setTimeout(() => {
        reject(new Error('timeout'))
      }, 30000)
      if ((status === 'start') || (status === 'pending')) {
        fetch(hostURL + 'save/status', {
          credentials: 'include',
          method: 'POST',
          body: val_data,
          headers: {
            'Accept': 'application/json'
          }
        }).then(resolve, reject)
      }
    })
    timeoutPromise
      .then(response => response.json())
      .then((data) => {
        status = data.status
        vdata = data
        chrome.runtime.sendMessage({
          message: 'resource_list_show',
          data: data,
          url: page_url
        })
      })
      .catch((err) => {
        chrome.runtime.sendMessage({
          message: 'resource_list_show',
          data: err,
          url: page_url
        })
      })
  }
  // update when done
  removeToolbarState(tabId, 'S')

  if (vdata.status === 'success') {
    // update UI
    addToolbarState(tabId, 'check')
    chrome.runtime.sendMessage({
      message: 'save_success',
      time: 'Last saved: ' + getLastSaveTime(vdata.timestamp),
      tabId: tabId
    })
    // increment and update wayback count
    incrementCount(vdata.original_url)
    chrome.runtime.sendMessage({ message: 'updateCountBadge' }) // not working
    // notify
    if (!silent) {
      let msg = 'Successfully saved! Click to view snapshot.'
      // replace message if present in result
      if (vdata.message && vdata.message.length > 0) {
        msg = vdata.message
      }
      notify(msg, (notificationId) => {
        chrome.notifications.onClicked.addListener((newNotificationId) => {
          if (notificationId === newNotificationId) {
            let snapshot_url = 'https://web.archive.org/web/' + vdata.timestamp + '/' + vdata.original_url
            openByWindowSetting(snapshot_url)
          }
        })
      })
    }
  } else if (!vdata.status || (status === 'error')) {
    // update UI
    chrome.runtime.sendMessage({
      message: 'save_error',
      error: vdata.message
    })
    // notify
    if (!silent) {
      notify('Error: ' + vdata.message, (notificationId) => {
        chrome.notifications.onClicked.addListener((newNotificationId) => {
          if (notificationId === newNotificationId) {
            openByWindowSetting('https://archive.org/account/login')
          }
        })
      })
    }
  }
}

function getWikipediaBooks(Url, onSuccess, onFail) {
  const requestUrl = hostURL + 'services/context/books?url='
  const url = requestUrl + encodeURIComponent(Url)
  // Encapsulate fetch with a timeout promise object
  const timeoutPromise = new Promise((resolve, reject) => {
    setTimeout(() => { reject(new Error('timeout')) }, 5000)
    fetch(url).then(resolve, reject)
  })
  return timeoutPromise
    .then(response => response.json())
    .then(data => {
      if (data) {
        onSuccess(data)
      } else {
        if (onFail) { onFail(null) }
      }
    })
    .catch(error => {
      if (onFail) { onFail(error) }
    })
}

function getTvNews(Url, onSuccess, onFail) {
  const requestUrl = hostURL + 'services/context/tvnews?url='
  const url = requestUrl + encodeURIComponent(Url)
  // Encapsulate fetch with a timeout promise object
  const timeoutPromise = new Promise((resolve, reject) => {
    setTimeout(() => { reject(new Error('timeout')) }, 5000)
    fetch(url).then(resolve, reject)
  })
  return timeoutPromise
    .then(response => response.json())
    .then(clips => {
      if (clips) {
        onSuccess(clips)
      } else {
        if (onFail) { onFail(null) }
      }
    })
    .catch(error => {
      if (onFail) { onFail(error) }
    })
}
var check_wiki_api_call = false
function getCachedWikipediaBooks(url, onSuccess, onFail) {
  if (check_wiki_api_call === false) {
    check_wiki_api_call = true
    setTimeout(() => {
      check_wiki_api_call = false
    }, 1000)
    let cacheWikipediaBooks = wikipediaBooksCache.get(url)
    if (cacheWikipediaBooks) {
      onSuccess(cacheWikipediaBooks)
    } else {
      getWikipediaBooks(url, (json) => {
        if (wikipediaBooksCache.size > 2) {
          let first_key = wikipediaBooksCache.keys().next().value
          wikipediaBooksCache.delete(first_key)
        }
        wikipediaBooksCache.set(url, json)
        onSuccess(json)
      }, onFail)
    }
  }
}

var check_tv_api_call = false
function getCachedTvNews(url, onSuccess, onFail) {
  if (check_tv_api_call === false) {
    check_tv_api_call = true
    setTimeout(() => {
      check_tv_api_call = false
    }, 1000)
    let cacheTvNews = tvNewsCache.get(url)
    if (cacheTvNews) {
      onSuccess(cacheTvNews)
    } else {
      getTvNews(url, (json) => {
        if (tvNewsCache.size > 2) {
          let first_key = tvNewsCache.keys().next().value
          tvNewsCache.delete(first_key)
        }
        tvNewsCache.set(url, json)
        onSuccess(json)
      }, onFail)
    }
  }
}

/* * * Startup related * * */

// Runs whenever extension starts up, except during incognito mode.
chrome.runtime.onStartup.addListener((details) => {
  chrome.storage.local.get({ agreement: false }, (result) => {
    if (result.agreement === true) {
      chrome.browserAction.setPopup({ popup: 'index.html' })
    }
  })
})

// Runs when extension first installed or updated, or browser updated.
chrome.runtime.onInstalled.addListener((details) => {
  initDefaultOptions()
  chrome.storage.local.get({ agreement: false }, (result) => {
    if (result.agreement === true) {
      afterAcceptOptions()
      chrome.browserAction.setPopup({ popup: 'index.html' })
    }
  })
})

chrome.browserAction.onClicked.addListener((tab) => {
  openByWindowSetting(chrome.runtime.getURL('welcome.html'), 'tab')
})

chrome.webRequest.onBeforeSendHeaders.addListener(
  rewriteUserAgentHeader,
  { urls: [WB_API_URL] },
  ['blocking', 'requestHeaders']
)

chrome.webRequest.onErrorOccurred.addListener((details) => {
  if (['net::ERR_NAME_NOT_RESOLVED', 'net::ERR_NAME_RESOLUTION_FAILED',
    'net::ERR_CONNECTION_TIMED_OUT', 'net::ERR_NAME_NOT_RESOLVED'].indexOf(details.error) >= 0 &&
    details.tabId > 0) {
    chrome.storage.local.get(['not_found_popup', 'agreement'], (event) => {
      if (event.not_found_popup === true && event.agreement === true) {
        wmAvailabilityCheck(details.url, (wayback_url, url) => {
          chrome.tabs.sendMessage(details.tabId, {
            type: 'SHOW_BANNER',
            wayback_url: wayback_url,
            page_url: url,
            status_code: 999
          })
        }, () => {})
      }
    })
  }
}, { urls: ['<all_urls>'], types: ['main_frame'] })

/**
* Header callback
*/
chrome.webRequest.onCompleted.addListener((details) => {
  function tabIsReady(isIncognito) {
    if (isIncognito === false && details.frameId === 0 &&
      details.statusCode >= 400 && isNotExcludedUrl(details.url)) {
      globalStatusCode = details.statusCode
      wmAvailabilityCheck(details.url, (wayback_url, url) => {
        chrome.tabs.executeScript(details.tabId, {
          file: 'scripts/archive.js'
        }, () => {
          if (chrome.runtime.lastError && chrome.runtime.lastError.message.startsWith('Cannot access contents of url "chrome-error://chromewebdata/')) {
            chrome.tabs.sendMessage(details.tabId, {
              type: 'SHOW_BANNER',
              wayback_url: wayback_url,
              page_url: url,
              status_code: 999
            })
          } else {
            chrome.tabs.sendMessage(details.tabId, {
              type: 'SHOW_BANNER',
              wayback_url: wayback_url,
              page_url: details.url,
              status_code: details.statusCode
            })
          }
        })
      }, () => {})
    }
  }
  if (details.tabId > 0) {
    chrome.tabs.query({ currentWindow: true }, (tabs) => {
      var tabsArr = tabs.map(tab => tab.id)
      if (tabsArr.indexOf(details.tabId) >= 0) {
        chrome.tabs.get(details.tabId, (tab) => {
          chrome.storage.local.get(['not_found_popup', 'agreement'], (event) => {
            if (event.not_found_popup === true && event.agreement === true) {
              tabIsReady(tab.incognito)
            }
          })
        })
      }
    })
  }
}, { urls: ['<all_urls>'], types: ['main_frame'] })

function getLastSaveTime(timestamp) {
  return viewableTimestamp(timestamp)
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.message === 'openurl') {
    let tabId = message.tabId
    var page_url = message.page_url
    var wayback_url = message.wayback_url
    var url = page_url.replace(/https:\/\/web\.archive\.org\/web\/(.+?)\//g, '')
    var open_url = wayback_url + encodeURI(url)
    if (isNotExcludedUrl(page_url)) {
      if (message.method !== 'save') {
        URLopener(open_url, url, true)
      } else {
        let options = (message.options !== null) ? message.options : []
        savePageNow(tabId, page_url, false, options)
        return true
      }
    }
  } else if (message.message === 'getLastSaveTime') {
    // get most recent saved time, remove hash for some sites
    const url = message.page_url.split('#')[0]
    wmAvailabilityCheck(url,
      (wb_url, url, timestamp) => {
        sendResponse({
          message: 'last_save',
          time: 'Last saved: ' + getLastSaveTime(timestamp)
        })
      },
      () => {
        sendResponse({
          message: 'last_save',
          time: "Page hasn't been saved"
        })
      })
    return true
  } else if (message.message === 'auth_check') {
    auth_check()
      .then(resp => sendResponse(resp))
    return true
  } else if (message.message === 'getWikipediaBooks') {
    // retrieve wikipedia books
    getCachedWikipediaBooks(message.query,
      (json) => { sendResponse(json) },
      (error) => { sendResponse({ error: error }) }
    )
  } else if (message.message === 'tvnews') {
    // retrieve tv news clips
    getCachedTvNews(message.article,
      (json) => { sendResponse(json) },
      (error) => { sendResponse({ error: error }) }
    )
  } else if (message.message === 'sendurl') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs && tabs[0]) {
        let url = get_clean_url(tabs[0].url)
        chrome.tabs.sendMessage(tabs[0].id, { url: url })
      }
    })
  } else if (message.message === 'changeBadge') {
    // used to change badge for auto-archive feature (not used?)
  } else if (message.message === 'showall' && isNotExcludedUrl(message.url)) {
    const context_url = chrome.runtime.getURL('context.html') + '?url=' + encodeURIComponent(message.url)
    tabIdPromise = new Promise((resolve) => {
      openByWindowSetting(context_url, null, resolve)
    })
  } else if (message.message === 'getToolbarState') {
    // retrieve the toolbar state set
    let state = getToolbarState(message.tabId)
    sendResponse({ stateArray: Array.from(state) })
  } else if (message.message === 'clearCountBadge') {
    // wayback count settings unchecked
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs && tabs[0]) {
        updateWaybackCountBadge(tabs[0].id, null)
      }
    })
  } else if (message.message === 'updateCountBadge') {
    // update wayback count badge
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs && tabs[0]) {
        let url = get_clean_url(tabs[0].url)
        updateWaybackCountBadge(tabs[0].id, url)
      }
    })
  } else if (message.message === 'clearResource') {
    // resources settings unchecked
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs && tabs[0]) {
        removeToolbarState(tabs[0].id, 'R')
      }
    })
  } else if (message.message === 'getCachedWaybackCount') {
    // retrive wayback count
    getCachedWaybackCount(message.url,
      (total) => { sendResponse({ total: total }) },
      (error) => { sendResponse({ error: error }) }
    )
  } else if (message.message === 'clearCountCache') {
    clearCountCache()
  }
  return true
})

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === 'complete') {
    updateWaybackCountBadge(tab.id, tab.url)
    chrome.storage.local.get(['auto_archive'], (event) => {
      // auto save page
      if (event.auto_archive === true) {
        auto_save(tab.id, tab.url)
      }
    })
  } else if (info.status === 'loading') {
    var received_url = tab.url
    clearToolbarState(tab.id)
    if (isNotExcludedUrl(received_url) && !received_url.includes('web.archive.org') && !(received_url.includes('alexa.com') || received_url.includes('whois.com') || received_url.includes('twitter.com') || received_url.includes('oauth'))) {
      let contextUrl = received_url
      received_url = received_url.replace(/^https?:\/\//, '')
      var open_url = received_url
      if (open_url.slice(-1) === '/') { open_url = received_url.substring(0, open_url.length - 1) }
      chrome.storage.local.get(['auto_update_context', 'show_context', 'resource'], (event) => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (tabs && tabs[0]) {
            if (event.resource === true) {
              const url = get_clean_url(tabs[0].url)
              const tabId = tabs[0].id
              const news_host = new URL(url).hostname
              // checking resource of amazon books
              if (url.includes('www.amazon')) {
                fetch(hostURL + 'services/context/amazonbooks?url=' + url)
                  .then(resp => resp.json())
                  .then(resp => {
                    if (('metadata' in resp && 'identifier' in resp['metadata']) || 'ocaid' in resp) {
                      addToolbarState(tabId, 'R')
                      // Storing the tab url as well as the fetched archive url for future use
                      chrome.storage.local.set({ 'tab_url': url, 'detail_url': resp['metadata']['identifier-access'] }, () => {})
                    }
                  })
              // checking resource of wikipedia books and papers
              } else if (url.match(/^https?:\/\/[\w\.]*wikipedia.org/)) {
                getCachedWikipediaBooks(url,
                  (data) => {
                    if (data && data.message !== 'No ISBNs found in page' && data.status !== 'error') {
                      addToolbarState(tabId, 'R')
                    }
                  }, () => {}
                )
              // checking resource of tv news
              } else if (newshosts.has(news_host)) {
                getCachedTvNews(url,
                  (clips) => {
                    if (clips && clips.status !== 'error') {
                      addToolbarState(tabId, 'R')
                    }
                  }, () => {}
                )
              }
            }
          }
        })
        if (event.auto_update_context === true) {
          if (tabIdPromise) {
            tabIdPromise.then((id) => {
              if (tabId !== id && tab.id !== id && isNotExcludedUrl(contextUrl)) {
                chrome.tabs.update(id, { url: chrome.runtime.getURL('context.html') + '?url=' + encodeURIComponent(contextUrl) })
              }
            })
          }
        }
      })
    }
  }
})

// Called whenever a browser tab is selected
chrome.tabs.onActivated.addListener((info) => {
  chrome.storage.local.get(['auto_update_context', 'resource'], (event) => {
    if ((event.resource === false) && (getToolbarState(info.tabId).has('R'))) {
      // reset toolbar if resource setting turned off
      removeToolbarState(info.tabId, 'R')
    } else {
      updateToolbar(info.tabId)
    }
    chrome.tabs.get(info.tabId, (tab) => {
      // update or clear count badge
      updateWaybackCountBadge(info.tabId, tab.url)
      // auto update context page
      if ((event.auto_update_context === true) && tabIdPromise) {
        tabIdPromise.then((id) => {
          if (info.tabId === tab.id && tab.tabId !== id && tab.url && isNotExcludedUrl(tab.url)) {
            chrome.tabs.update(id, { url: chrome.runtime.getURL('context.html') + '?url=' + encodeURIComponent(tab.url) })
          }
        })
      }
    })
  })
})

function auto_save(tabId, url) {
  if (isValidUrl(url) && isNotExcludedUrl(url)) {
    wmAvailabilityCheck(url,
      () => {
        // check if page is now in archive after auto-saved
        // (don't do anything)
      },
      () => {
        // set auto-save toolbar icon if page doesn't exist, then save it
        if (!getToolbarState(tabId).has('S')) {
          savePageNow(tabId, url, true)
        }
      }
    )
  }
}

/* * * Wayback Count * * */

function getCachedWaybackCount(url, onSuccess, onFail) {
  let cacheTotal = waybackCountCache[url]
  if (cacheTotal) {
    onSuccess(cacheTotal)
  } else {
    getWaybackCount(url, (total) => {
      waybackCountCache[url] = total
      onSuccess(total)
    }, onFail)
  }
}

function clearCountCache() {
  waybackCountCache = {}
}

/**
 * Adds +1 to url in cache, or set to 1 if it doesn't exist.
 * @param url {string}
 */
function incrementCount(url) {
  let cacheTotal = waybackCountCache[url]
  waybackCountCache[url] = (cacheTotal) ? cacheTotal + 1 : 1
}

function updateWaybackCountBadge(tabId, url) {
  chrome.storage.local.get(['wm_count'], (event) => {
    if (url && isValidUrl(url) && isNotExcludedUrl(url) && (event.wm_count === true)) {
      getCachedWaybackCount(url, (total) => {
        if (total > 0) {
          // display badge
          let text = badgeCountText(total)
          chrome.browserAction.setBadgeBackgroundColor({ color: '#9A3B38' }) // red
          chrome.browserAction.setBadgeText({ tabId: tabId, text: text })
        } else {
          chrome.browserAction.setBadgeText({ tabId: tabId, text: '' })
        }
      },
      (error) => {
        console.log('wayback count error: ' + error)
        chrome.browserAction.setBadgeText({ tabId: tabId, text: '' })
      })
    } else {
      chrome.browserAction.setBadgeText({ tabId: tabId, text: '' })
    }
  })
}

/* * * Toolbar * * */

/**
 * Sets the toolbar icon.
 * Name string is based on PNG image filename in images/toolbar/
 * @param name {string} = one of 'archive', 'check', 'R', or 'S'
 */
function setToolbarIcon(name) {
  const path = 'images/toolbar/toolbar-icon-'
  let n = ((name !== 'R') && (name !== 'S') && (name !== 'check')) ? 'archive' : name
  let details = {
    '16': (path + n + '16.png'),
    '24': (path + n + '24.png'),
    '32': (path + n + '32.png'),
    '64': (path + n + '64.png')
  }
  chrome.browserAction.setIcon({ path: details })
}

// Add state to the state set for given tabId, and update toolbar.
// state is 'S', 'R', or 'check'
function addToolbarState(tabId, state) {
  if (!gToolbarStates[tabId]) {
    gToolbarStates[tabId] = new Set()
  }
  gToolbarStates[tabId].add(state)
  updateToolbar(tabId)
}

// Remove state from the state set for given tabId, and update toolbar.
function removeToolbarState(tabId, state) {
  if (gToolbarStates[tabId]) {
    gToolbarStates[tabId].delete(state)
  }
  updateToolbar(tabId)
}

// Returns a Set of toolbar states, or an empty set.
function getToolbarState(tabId) {
  return (gToolbarStates[tabId]) ? gToolbarStates[tabId] : new Set()
}

// Clears state for given tabId and update toolbar icon.
function clearToolbarState(tabId) {
  if (gToolbarStates[tabId]) {
    gToolbarStates[tabId].clear()
    delete gToolbarStates[tabId]
  }
  updateToolbar(tabId)
}

/**
 * Updates the toolbar icon using the state set stored in gToolbarStates.
 * Only updates icon if tabId is the currently active tab, else does nothing.
 * @param tabId {integer}
 */
function updateToolbar(tabId) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs && tabs[0] && (tabs[0].id === tabId)) {
      let state = gToolbarStates[tabId]
      // this order defines the priority of what icon to display
      if (state && state.has('S')) {
        setToolbarIcon('S')
      } else if (state && state.has('R')) {
        setToolbarIcon('R')
      } else if (state && state.has('check')) {
        setToolbarIcon('check')
      } else {
        setToolbarIcon('archive')
      }
    }
  })
}

/* * * Right-click Menu * * */

// Right-click context menu "Wayback Machine" inside the page.
chrome.contextMenus.create({
  'id': 'first',
  'title': 'Oldest Version',
  'contexts': ['all'],
  'documentUrlPatterns': ['*://*/*', 'ftp://*/*']
})
chrome.contextMenus.create({
  'id': 'recent',
  'title': 'Newest Version',
  'contexts': ['all'],
  'documentUrlPatterns': ['*://*/*', 'ftp://*/*']
})
chrome.contextMenus.create({
  'id': 'all',
  'title': 'All Versions',
  'contexts': ['all'],
  'documentUrlPatterns': ['*://*/*', 'ftp://*/*']
})
chrome.contextMenus.create({
  'id': 'save',
  'title': 'Save Page Now',
  'contexts': ['all'],
  'documentUrlPatterns': ['*://*/*', 'ftp://*/*']
})

chrome.contextMenus.onClicked.addListener((click) => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (['first', 'recent', 'save', 'all'].indexOf(click.menuItemId) >= 0) {
      const page_url = get_clean_url(click.linkUrl) || get_clean_url(tabs[0].url)
      let wayback_url
      let wmIsAvailable = true
      if (isValidUrl(page_url) && isNotExcludedUrl(page_url)) {
        if (click.menuItemId === 'first') {
          wayback_url = 'https://web.archive.org/web/0/' + encodeURI(page_url)
        } else if (click.menuItemId === 'recent') {
          wayback_url = 'https://web.archive.org/web/2/' + encodeURI(page_url)
        } else if (click.menuItemId === 'save') {
          let tabId = tabs[0].id
          if (isNotExcludedUrl(page_url)) {
            let options = ['capture_all']
            savePageNow(tabId, page_url, false, options)
            return true
          }
        } else if (click.menuItemId === 'all') {
          wmIsAvailable = false
          wayback_url = 'https://web.archive.org/web/*/' + encodeURI(page_url)
        }
        URLopener(wayback_url, page_url, wmIsAvailable)
      } else {
        alert('This URL is in the list of excluded URLs')
      }
    }
  })
})
