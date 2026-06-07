const TOKEN = ENV_BOT_TOKEN // Get it from @BotFather
const WEBHOOK = '/endpoint'
const SECRET = ENV_BOT_SECRET // A-Z, a-z, 0-9, _ and -
const ADMIN_UID = ENV_ADMIN_UID // your user id, get it from https://t.me/username_to_id_bot

const NOTIFY_INTERVAL = 3600 * 1000
const FRAUD_CACHE_MAX_AGE = 3600 * 1000
const TEXT_CACHE_MAX_AGE = 3600 * 1000
const MESSAGE_MAP_TTL = 30 * 24 * 3600
const LASTMSG_TTL = 30 * 24 * 3600
const VERIFY_CHALLENGE_TTL = 10 * 60

const fraudDb = 'https://raw.githubusercontent.com/LloydAsp/nfd/main/data/fraud.db'
const notificationUrl = 'https://raw.githubusercontent.com/LloydAsp/nfd/main/data/notification.txt'

const enable_notification = false

const START_MESSAGE = `NFD 是一个 Telegram 私聊转发机器人。
你发送给本 Bot 的消息会转发给管理员，管理员回复后会由 Bot 转回给你。
为减少垃圾消息，首次使用需要完成一道简单数学题验证。`

const DEFAULT_NOTIFICATION = `1. 交易前核实对方在NodeSeek论坛用户身份，不要直接与论坛外用户交易
2. 交易前核实卖家有产品，有可能的话可以尝试先登录
3. 尽量不要通过虚拟货币交易，因为虚拟货币不可被举报及追回
4. 大额交易尽量走论坛中介，如果对方不愿意走中介则风险较高，慎重交易

如果怀疑聊天对象是骗子，请第一时间到NodeSeek论坛反馈或者到群组 @nodeseekg 反馈。`

/**
 * Return url to telegram api, optionally with parameters added
 */
function apiUrl (methodName, params = null) {
  let query = ''
  if (params) {
    query = '?' + new URLSearchParams(params).toString()
  }
  return `https://api.telegram.org/bot${TOKEN}/${methodName}${query}`
}

async function requestTelegram (methodName, body, params = null) {
  try {
    const response = await fetch(apiUrl(methodName, params), body)
    let result
    try {
      result = await response.json()
    } catch (error) {
      return {
        ok: false,
        error_code: response.status,
        description: `Invalid Telegram JSON response: ${safeError(error)}`,
      }
    }
    if (!response.ok || !result.ok) {
      console.log(`Telegram API ${methodName} failed: ${result.description || response.status}`)
    }
    return result
  } catch (error) {
    console.log(`Telegram API ${methodName} request failed: ${safeError(error)}`)
    return {
      ok: false,
      error_code: 0,
      description: safeError(error),
    }
  }
}

function makeReqBody (body) {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  }
}

function sendMessage (msg = {}) {
  return requestTelegram('sendMessage', makeReqBody(msg))
}

function copyMessage (msg = {}) {
  return requestTelegram('copyMessage', makeReqBody(msg))
}

function forwardMessage (msg) {
  return requestTelegram('forwardMessage', makeReqBody(msg))
}

function safeError (error) {
  return error?.message || String(error)
}

function telegramErrorText (result) {
  return result?.description || `错误码：${result?.error_code || 'unknown'}`
}

function adminUid () {
  return ADMIN_UID.toString()
}

function isAdminMessage (message) {
  return message.chat.id.toString() === adminUid()
}

function isPrivateChat (message) {
  return !message.chat.type || message.chat.type === 'private'
}

function isTruthyKvValue (value) {
  return value === true || value === 'true' || value === 1 || value === '1'
}

async function kvGetJson (key) {
  try {
    return await nfd.get(key, { type: 'json' })
  } catch (error) {
    console.log(`KV get ${key} failed: ${safeError(error)}`)
    return null
  }
}

function kvPutJson (key, value, options = undefined) {
  return nfd.put(key, JSON.stringify(value), options)
}

async function fetchTextWithCache (url, cacheKey, maxAge, fallbackText = '') {
  const cached = await kvGetJson(cacheKey)
  const hasCachedText = cached && typeof cached.text === 'string'
  const cachedAt = Number(cached?.cachedAt || 0)

  if (hasCachedText && Date.now() - cachedAt < maxAge) {
    return cached.text
  }

  try {
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    const text = await response.text()
    await kvPutJson(cacheKey, {
      text,
      cachedAt: Date.now(),
    })
    return text
  } catch (error) {
    console.log(`Fetch ${cacheKey} failed: ${safeError(error)}`)
    if (hasCachedText) {
      return cached.text
    }
    return fallbackText
  }
}

function isManagementAuthorized (request, url) {
  return SECRET && (
    url.searchParams.get('secret') === SECRET ||
    request.headers.get('X-NFD-Secret') === SECRET
  )
}

async function handleManagementRequest (event, url, handler) {
  if (!isManagementAuthorized(event.request, url)) {
    return new Response('Unauthorized', { status: 403 })
  }
  return handler()
}

/**
 * Wait for requests to the worker
 */
addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  if (url.pathname === WEBHOOK) {
    event.respondWith(handleWebhook(event))
  } else if (url.pathname === '/registerWebhook') {
    event.respondWith(handleManagementRequest(event, url, () => registerWebhook(url, WEBHOOK, SECRET)))
  } else if (url.pathname === '/unRegisterWebhook') {
    event.respondWith(handleManagementRequest(event, url, () => unRegisterWebhook()))
  } else {
    event.respondWith(new Response('No handler for this request'))
  }
})

/**
 * Handle requests to WEBHOOK
 * https://core.telegram.org/bots/api#update
 */
async function handleWebhook (event) {
  // Check secret
  if (event.request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== SECRET) {
    return new Response('Unauthorized', { status: 403 })
  }

  let update
  try {
    update = await event.request.json()
  } catch (error) {
    return new Response(`Bad Request: ${safeError(error)}`, { status: 400 })
  }

  event.waitUntil(onUpdate(update).catch(error => {
    console.log(`Update handling failed: ${safeError(error)}`)
  }))

  return new Response('Ok')
}

/**
 * Handle incoming Update
 * https://core.telegram.org/bots/api#update
 */
async function onUpdate (update) {
  if ('message' in update) {
    await onMessage(update.message)
  }
}

/**
 * Handle incoming Message
 * https://core.telegram.org/bots/api#message
 */
async function onMessage (message) {
  if (!isPrivateChat(message)) {
    return
  }

  if (/^\/start(?:\s|$)/.exec(message.text || '')) {
    return handleStart(message)
  }

  if (isAdminMessage(message)) {
    if (!message?.reply_to_message?.chat) {
      return sendMessage({
        chat_id: adminUid(),
        text: '使用方法：回复转发的消息，并发送回复消息，或者使用 `/block`、`/unblock`、`/checkblock` 等指令',
      })
    }
    if (/^\/block$/.exec(message.text || '')) {
      return handleBlock(message)
    }
    if (/^\/unblock$/.exec(message.text || '')) {
      return handleUnBlock(message)
    }
    if (/^\/checkblock$/.exec(message.text || '')) {
      return checkBlock(message)
    }
    return handleAdminReply(message)
  }
  return handleGuestMessage(message)
}

async function handleStart (message) {
  let text = START_MESSAGE
  if (!isAdminMessage(message)) {
    if (await isVerified(message.chat.id)) {
      text += '\n\n你已通过验证，可以直接发送消息。'
    } else {
      const challenge = await getOrCreateVerificationChallenge(message.chat.id)
      text += `\n\n人机验证：${challenge.question}\n请直接发送答案。验证通过前，消息不会被转发给管理员。`
    }
  }
  return sendMessage({
    chat_id: message.chat.id,
    text,
  })
}

async function handleAdminReply (message) {
  const guestChatId = await getGuestChatIdFromReply(message)
  if (!guestChatId) {
    return sendMessage({
      chat_id: adminUid(),
      text: '未找到这条回复对应的访客，请确认你回复的是 Bot 转发给你的消息。',
    })
  }

  const result = await copyMessage({
    chat_id: guestChatId,
    from_chat_id: message.chat.id,
    message_id: message.message_id,
  })
  if (!result.ok) {
    return sendMessage({
      chat_id: adminUid(),
      text: `回复发送失败：${telegramErrorText(result)}`,
    })
  }
}

async function handleGuestMessage (message) {
  const chatId = message.chat.id.toString()
  const isblocked = isTruthyKvValue(await kvGetJson('isblocked-' + chatId))

  if (isblocked) {
    return sendMessage({
      chat_id: chatId,
      text: 'You are blocked',
    })
  }

  if (!await ensureHumanVerified(message)) {
    return
  }

  const forwardReq = await forwardMessage({
    chat_id: adminUid(),
    from_chat_id: message.chat.id,
    message_id: message.message_id,
  })

  if (!forwardReq.ok) {
    return sendMessage({
      chat_id: chatId,
      text: `消息转发失败，请稍后再试。${telegramErrorText(forwardReq)}`,
    })
  }

  await kvPutJson('msg-map-' + forwardReq.result.message_id, chatId, {
    expirationTtl: MESSAGE_MAP_TTL,
  })
  return handleNotify(message)
}

async function handleNotify (message) {
  // 先判断是否是诈骗人员，如果是，则直接提醒
  // 如果不是，则根据时间间隔提醒：用户id，交易注意点等
  const chatId = message.chat.id.toString()
  if (await isFraud(chatId)) {
    return sendMessage({
      chat_id: adminUid(),
      text: `检测到骗子，UID${chatId}`,
    })
  }
  if (enable_notification) {
    const lastMsgTime = Number(await kvGetJson('lastmsg-' + chatId) || 0)
    if (!lastMsgTime || Date.now() - lastMsgTime > NOTIFY_INTERVAL) {
      await kvPutJson('lastmsg-' + chatId, Date.now(), {
        expirationTtl: LASTMSG_TTL,
      })
      return sendMessage({
        chat_id: adminUid(),
        text: await fetchTextWithCache(notificationUrl, 'cache-notification-text', TEXT_CACHE_MAX_AGE, DEFAULT_NOTIFICATION),
      })
    }
  }
}

async function handleBlock (message) {
  const guestChatId = await getGuestChatIdFromReply(message)
  if (!guestChatId) {
    return sendMessage({
      chat_id: adminUid(),
      text: '未找到这条回复对应的访客，无法屏蔽。',
    })
  }
  if (guestChatId === adminUid()) {
    return sendMessage({
      chat_id: adminUid(),
      text: '不能屏蔽自己',
    })
  }
  await kvPutJson('isblocked-' + guestChatId, true)

  return sendMessage({
    chat_id: adminUid(),
    text: `UID:${guestChatId}屏蔽成功`,
  })
}

async function handleUnBlock (message) {
  const guestChatId = await getGuestChatIdFromReply(message)
  if (!guestChatId) {
    return sendMessage({
      chat_id: adminUid(),
      text: '未找到这条回复对应的访客，无法解除屏蔽。',
    })
  }

  await nfd.delete('isblocked-' + guestChatId)

  return sendMessage({
    chat_id: adminUid(),
    text: `UID:${guestChatId}解除屏蔽成功`,
  })
}

async function checkBlock (message) {
  const guestChatId = await getGuestChatIdFromReply(message)
  if (!guestChatId) {
    return sendMessage({
      chat_id: adminUid(),
      text: '未找到这条回复对应的访客，无法检查屏蔽状态。',
    })
  }
  const blocked = isTruthyKvValue(await kvGetJson('isblocked-' + guestChatId))

  return sendMessage({
    chat_id: adminUid(),
    text: `UID:${guestChatId}` + (blocked ? '被屏蔽' : '没有被屏蔽'),
  })
}

async function getGuestChatIdFromReply (message) {
  const replyMessageId = message?.reply_to_message?.message_id
  if (!replyMessageId) {
    return null
  }
  const guestChatId = await kvGetJson('msg-map-' + replyMessageId)
  if (guestChatId === null || guestChatId === undefined || guestChatId === '') {
    return null
  }
  return guestChatId.toString()
}

function verifiedKey (chatId) {
  return 'verified-' + chatId
}

function challengeKey (chatId) {
  return 'verify-challenge-' + chatId
}

async function isVerified (chatId) {
  return isTruthyKvValue(await kvGetJson(verifiedKey(chatId)))
}

function randomInt (min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function createVerificationChallenge () {
  const a = randomInt(2, 20)
  const b = randomInt(2, 20)
  return {
    question: `${a} + ${b} = ?`,
    answer: a + b,
    createdAt: Date.now(),
  }
}

async function getOrCreateVerificationChallenge (chatId) {
  const key = challengeKey(chatId)
  const challenge = await kvGetJson(key)
  if (challenge && typeof challenge.question === 'string' && Number.isFinite(Number(challenge.answer))) {
    return challenge
  }
  const newChallenge = createVerificationChallenge()
  await kvPutJson(key, newChallenge, {
    expirationTtl: VERIFY_CHALLENGE_TTL,
  })
  return newChallenge
}

function parseVerificationAnswer (text) {
  const answer = (text || '').trim()
  if (!/^-?\d+$/.exec(answer)) {
    return null
  }
  return Number(answer)
}

async function ensureHumanVerified (message) {
  const chatId = message.chat.id.toString()
  if (await isVerified(chatId)) {
    return true
  }

  const challenge = await getOrCreateVerificationChallenge(chatId)
  const answer = parseVerificationAnswer(message.text)
  if (answer !== null && answer === Number(challenge.answer)) {
    await kvPutJson(verifiedKey(chatId), true)
    await nfd.delete(challengeKey(chatId))
    await sendMessage({
      chat_id: chatId,
      text: '验证通过，请重新发送你要转发的消息。',
    })
    return false
  }

  return sendMessage({
    chat_id: chatId,
    text: `请先完成人机验证：${challenge.question}\n直接发送答案即可。验证通过前，消息不会被转发给管理员。`,
  }).then(() => false)
}

/**
 * Set webhook to this worker's url
 * https://core.telegram.org/bots/api#setwebhook
 */
async function registerWebhook (requestUrl, suffix, secret) {
  // https://core.telegram.org/bots/api#setwebhook
  const webhookUrl = `${requestUrl.protocol}//${requestUrl.hostname}${suffix}`
  const r = await requestTelegram('setWebhook', undefined, {
    url: webhookUrl,
    secret_token: secret,
  })
  return new Response(r.ok ? 'Ok' : JSON.stringify(r, null, 2), {
    status: r.ok ? 200 : 502,
  })
}

/**
 * Remove webhook
 * https://core.telegram.org/bots/api#setwebhook
 */
async function unRegisterWebhook () {
  const r = await requestTelegram('setWebhook', undefined, { url: '' })
  return new Response(r.ok ? 'Ok' : JSON.stringify(r, null, 2), {
    status: r.ok ? 200 : 502,
  })
}

async function isFraud (id) {
  id = id.toString()
  const db = await fetchTextWithCache(fraudDb, 'cache-fraud-db', FRAUD_CACHE_MAX_AGE)
  if (!db) {
    return false
  }
  return db.split(/\r?\n/).some(v => v.trim() === id)
}
