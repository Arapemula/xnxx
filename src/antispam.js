// antispam.js
// Anti-Spam Protection Middleware & Utilities

/**
 * ===========================================
 * ANTI-SPAM CONFIGURATION
 * ===========================================
 */
const CONFIG = {
  // Rate Limiting for API Requests
  api: {
    windowMs: 60 * 1000,           // 1 minute window
    maxRequests: 100,              // Max 100 requests per window
    blockDurationMs: 5 * 60 * 1000, // Block for 5 minutes if exceeded
  },
  
  // Rate Limiting for Auth endpoints (login/register)
  auth: {
    windowMs: 15 * 60 * 1000,      // 15 minute window  
    maxRequests: 10,               // Max 10 attempts per window
    blockDurationMs: 30 * 60 * 1000, // Block for 30 minutes if exceeded
  },

  // Rate Limiting for Message Sending
  message: {
    windowMs: 60 * 1000,           // 1 minute window
    maxMessages: 30,               // Max 30 messages per minute per session
    blockDurationMs: 5 * 60 * 1000, // Block for 5 minutes if exceeded
  },

  // WhatsApp User Message Rate Limiting (incoming)
  waUser: {
    windowMs: 60 * 1000,           // 1 minute window
    maxMessages: 20,               // Max 20 messages per minute per user
    warnThreshold: 15,             // Warn at 15 messages
    autoReplyThrottle: 5 * 1000,   // Only auto-reply once per 5 seconds per user
  },

  // Broadcast Limiting
  broadcast: {
    windowMs: 60 * 60 * 1000,      // 1 hour window
    maxBroadcasts: 3,              // Max 3 broadcast operations per hour
    maxRecipientsPerBroadcast: 500, // Max 500 recipients per broadcast
    delayBetweenMessages: 2000,    // 2 seconds delay between broadcast messages
  },

  // Socket Connection Limiting
  socket: {
    maxConnectionsPerIP: 10,       // Max 10 socket connections per IP
    reconnectCooldownMs: 1000,     // 1 second cooldown between reconnects
  },
};

/**
 * ===========================================
 * STORAGE FOR RATE LIMITING
 * ===========================================
 */
const storage = {
  // API Rate Limiting: { [ip]: { count, firstRequest, blockedUntil } }
  apiRequests: new Map(),
  
  // Auth Rate Limiting: { [ip]: { count, firstRequest, blockedUntil } }
  authRequests: new Map(),

  // Message Sending Rate Limiting: { [sessionId]: { count, firstRequest, blockedUntil } }
  messageRequests: new Map(),
  
  // WhatsApp User Rate Limiting: { [sessionId:userJid]: { count, firstMessage, lastAutoReply, warned } }
  waUserMessages: new Map(),
  
  // Broadcast Rate Limiting: { [sessionId]: { count, firstBroadcast, blockedUntil } }
  broadcastRequests: new Map(),

  // Socket Connections: { [ip]: Set of socketIds }
  socketConnections: new Map(),

  // Blacklisted IPs
  blacklistedIPs: new Set(),

  // Blacklisted WhatsApp Users (JIDs)
  blacklistedUsers: new Map(), // { [sessionId:userJid]: { reason, until } }

  // Whitelisted IPs (bypass rate limiting)
  whitelistedIPs: new Set(['127.0.0.1', '::1', 'localhost']),
};

/**
 * ===========================================
 * UTILITY FUNCTIONS
 * ===========================================
 */

// Get client IP from request
const getClientIP = (req) => {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.connection?.remoteAddress ||
    req.socket?.remoteAddress ||
    'unknown'
  );
};

// Clean expired entries from a Map
const cleanExpiredEntries = (map, windowMs) => {
  const now = Date.now();
  for (const [key, value] of map.entries()) {
    if (value.blockedUntil && now >= value.blockedUntil) {
      // Unblock but keep tracking
      value.blockedUntil = null;
      value.count = 0;
      value.firstRequest = null;
    } else if (value.firstRequest && now - value.firstRequest > windowMs) {
      // Window expired, reset count
      value.count = 0;
      value.firstRequest = null;
    }
  }
};

// Periodic cleanup (run every 5 minutes)
setInterval(() => {
  cleanExpiredEntries(storage.apiRequests, CONFIG.api.windowMs);
  cleanExpiredEntries(storage.authRequests, CONFIG.auth.windowMs);
  cleanExpiredEntries(storage.messageRequests, CONFIG.message.windowMs);
  cleanExpiredEntries(storage.broadcastRequests, CONFIG.broadcast.windowMs);
  
  // Clean WA User messages
  const now = Date.now();
  for (const [key, value] of storage.waUserMessages.entries()) {
    if (value.firstMessage && now - value.firstMessage > CONFIG.waUser.windowMs) {
      value.count = 0;
      value.firstMessage = null;
      value.warned = false;
    }
  }

  // Clean expired blacklisted users
  for (const [key, value] of storage.blacklistedUsers.entries()) {
    if (value.until && now >= value.until) {
      storage.blacklistedUsers.delete(key);
    }
  }
}, 5 * 60 * 1000);

/**
 * ===========================================
 * RATE LIMITING MIDDLEWARE
 * ===========================================
 */

// Generic rate limiter factory
const createRateLimiter = (config, storageMap, keyExtractor) => {
  return (req, res, next) => {
    const key = keyExtractor(req);
    const ip = getClientIP(req);
    
    // Skip if whitelisted
    if (storage.whitelistedIPs.has(ip)) {
      return next();
    }

    // Check if IP is blacklisted
    if (storage.blacklistedIPs.has(ip)) {
      return res.status(403).json({
        error: 'Access denied',
        message: 'IP anda telah di-blacklist karena aktivitas mencurigakan',
        code: 'IP_BLACKLISTED'
      });
    }

    const now = Date.now();
    let record = storageMap.get(key);

    if (!record) {
      record = { count: 0, firstRequest: null, blockedUntil: null };
      storageMap.set(key, record);
    }

    // Check if currently blocked
    if (record.blockedUntil && now < record.blockedUntil) {
      const remainingMs = record.blockedUntil - now;
      const remainingSec = Math.ceil(remainingMs / 1000);
      return res.status(429).json({
        error: 'Too many requests',
        message: `Terlalu banyak request. Coba lagi dalam ${remainingSec} detik`,
        retryAfter: remainingSec,
        code: 'RATE_LIMITED'
      });
    }

    // Reset if window expired
    if (record.firstRequest && now - record.firstRequest > config.windowMs) {
      record.count = 0;
      record.firstRequest = null;
      record.blockedUntil = null;
    }

    // Initialize first request time
    if (!record.firstRequest) {
      record.firstRequest = now;
    }

    // Increment counter
    record.count++;

    // Check if exceeded
    if (record.count > config.maxRequests) {
      record.blockedUntil = now + config.blockDurationMs;
      const remainingSec = Math.ceil(config.blockDurationMs / 1000);
      
      console.log(`[ANTISPAM] Rate limit exceeded for ${key}`);
      
      return res.status(429).json({
        error: 'Too many requests',
        message: `Rate limit terlampaui. Anda diblokir selama ${remainingSec} detik`,
        retryAfter: remainingSec,
        code: 'RATE_LIMITED'
      });
    }

    // Add headers
    res.setHeader('X-RateLimit-Limit', config.maxRequests);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, config.maxRequests - record.count));
    res.setHeader('X-RateLimit-Reset', Math.ceil((record.firstRequest + config.windowMs) / 1000));

    next();
  };
};

// API Rate Limiter Middleware
const apiRateLimiter = createRateLimiter(
  CONFIG.api,
  storage.apiRequests,
  (req) => getClientIP(req)
);

// Auth Rate Limiter Middleware (stricter)
const authRateLimiter = createRateLimiter(
  CONFIG.auth,
  storage.authRequests,
  (req) => getClientIP(req)
);

// Message Sending Rate Limiter
const messageRateLimiter = createRateLimiter(
  CONFIG.message,
  storage.messageRequests,
  (req) => req.body?.sessionId || 'unknown'
);

// Broadcast Rate Limiter
const broadcastRateLimiter = (req, res, next) => {
  const sessionId = req.body?.sessionId;
  const recipients = req.body?.recipients || [];
  
  if (!sessionId) {
    return next();
  }

  const now = Date.now();
  let record = storage.broadcastRequests.get(sessionId);

  if (!record) {
    record = { count: 0, firstBroadcast: null, blockedUntil: null };
    storage.broadcastRequests.set(sessionId, record);
  }

  // Check if blocked
  if (record.blockedUntil && now < record.blockedUntil) {
    const remainingMs = record.blockedUntil - now;
    const remainingMin = Math.ceil(remainingMs / 60000);
    return res.status(429).json({
      error: 'Broadcast limit reached',
      message: `Batas broadcast tercapai. Coba lagi dalam ${remainingMin} menit`,
      code: 'BROADCAST_LIMITED'
    });
  }

  // Reset if window expired
  if (record.firstBroadcast && now - record.firstBroadcast > CONFIG.broadcast.windowMs) {
    record.count = 0;
    record.firstBroadcast = null;
  }

  // Check recipient count
  if (recipients.length > CONFIG.broadcast.maxRecipientsPerBroadcast) {
    return res.status(400).json({
      error: 'Too many recipients',
      message: `Maksimal ${CONFIG.broadcast.maxRecipientsPerBroadcast} penerima per broadcast`,
      code: 'TOO_MANY_RECIPIENTS'
    });
  }

  // Initialize first broadcast time
  if (!record.firstBroadcast) {
    record.firstBroadcast = now;
  }

  record.count++;

  // Check if exceeded
  if (record.count > CONFIG.broadcast.maxBroadcasts) {
    record.blockedUntil = now + CONFIG.broadcast.windowMs;
    return res.status(429).json({
      error: 'Broadcast limit reached',
      message: `Maksimal ${CONFIG.broadcast.maxBroadcasts} broadcast per jam`,
      code: 'BROADCAST_LIMITED'
    });
  }

  // Attach delay config to request for use in handler
  req.broadcastDelay = CONFIG.broadcast.delayBetweenMessages;

  next();
};

/**
 * ===========================================
 * WHATSAPP USER SPAM DETECTION
 * ===========================================
 */

// Check if a WhatsApp user is sending too many messages
const checkWAUserSpam = (sessionId, userJid) => {
  const key = `${sessionId}:${userJid}`;
  const now = Date.now();
  let record = storage.waUserMessages.get(key);

  if (!record) {
    record = { count: 0, firstMessage: null, lastAutoReply: null, warned: false };
    storage.waUserMessages.set(key, record);
  }

  // Reset if window expired
  if (record.firstMessage && now - record.firstMessage > CONFIG.waUser.windowMs) {
    record.count = 0;
    record.firstMessage = null;
    record.warned = false;
  }

  // Initialize first message time
  if (!record.firstMessage) {
    record.firstMessage = now;
  }

  record.count++;

  const result = {
    isSpam: record.count > CONFIG.waUser.maxMessages,
    shouldWarn: record.count >= CONFIG.waUser.warnThreshold && !record.warned,
    messageCount: record.count,
    canAutoReply: !record.lastAutoReply || (now - record.lastAutoReply) > CONFIG.waUser.autoReplyThrottle,
  };

  if (result.shouldWarn) {
    record.warned = true;
  }

  return result;
};

// Mark that auto-reply was sent
const markAutoReplySent = (sessionId, userJid) => {
  const key = `${sessionId}:${userJid}`;
  const record = storage.waUserMessages.get(key);
  if (record) {
    record.lastAutoReply = Date.now();
  }
};

// Check if user is blacklisted
const isUserBlacklisted = (sessionId, userJid) => {
  const key = `${sessionId}:${userJid}`;
  const record = storage.blacklistedUsers.get(key);
  
  if (!record) return false;
  
  // Check if blacklist expired
  if (record.until && Date.now() >= record.until) {
    storage.blacklistedUsers.delete(key);
    return false;
  }
  
  return true;
};

// Blacklist a user
const blacklistUser = (sessionId, userJid, reason = 'Spam', durationMs = 24 * 60 * 60 * 1000) => {
  const key = `${sessionId}:${userJid}`;
  storage.blacklistedUsers.set(key, {
    reason,
    until: Date.now() + durationMs,
    createdAt: Date.now()
  });
  console.log(`[ANTISPAM] User blacklisted: ${userJid} for ${reason}`);
};

// Unblacklist a user
const unblacklistUser = (sessionId, userJid) => {
  const key = `${sessionId}:${userJid}`;
  storage.blacklistedUsers.delete(key);
  console.log(`[ANTISPAM] User unblacklisted: ${userJid}`);
};

/**
 * ===========================================
 * IP MANAGEMENT
 * ===========================================
 */

// Blacklist an IP
const blacklistIP = (ip, reason = 'Manual') => {
  storage.blacklistedIPs.add(ip);
  console.log(`[ANTISPAM] IP blacklisted: ${ip} for ${reason}`);
};

// Unblacklist an IP
const unblacklistIP = (ip) => {
  storage.blacklistedIPs.delete(ip);
  console.log(`[ANTISPAM] IP unblacklisted: ${ip}`);
};

// Whitelist an IP
const whitelistIP = (ip) => {
  storage.whitelistedIPs.add(ip);
  console.log(`[ANTISPAM] IP whitelisted: ${ip}`);
};

// Remove from whitelist
const unwhitelistIP = (ip) => {
  storage.whitelistedIPs.delete(ip);
  console.log(`[ANTISPAM] IP removed from whitelist: ${ip}`);
};

/**
 * ===========================================
 * SOCKET.IO PROTECTION
 * ===========================================
 */

// Socket connection limiter
const socketConnectionLimiter = (socket, next) => {
  const ip = socket.handshake.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
             socket.handshake.address ||
             'unknown';

  // Skip if whitelisted
  if (storage.whitelistedIPs.has(ip)) {
    return next();
  }

  // Check if IP is blacklisted
  if (storage.blacklistedIPs.has(ip)) {
    return next(new Error('Access denied'));
  }

  let connections = storage.socketConnections.get(ip);
  if (!connections) {
    connections = new Set();
    storage.socketConnections.set(ip, connections);
  }

  // Check connection limit
  if (connections.size >= CONFIG.socket.maxConnectionsPerIP) {
    console.log(`[ANTISPAM] Socket connection limit exceeded for IP: ${ip}`);
    return next(new Error('Too many connections'));
  }

  // Track this connection
  connections.add(socket.id);

  // Remove on disconnect
  socket.on('disconnect', () => {
    connections.delete(socket.id);
    if (connections.size === 0) {
      storage.socketConnections.delete(ip);
    }
  });

  next();
};

/**
 * ===========================================
 * STATS & MONITORING
 * ===========================================
 */

// Get anti-spam statistics
const getStats = () => {
  return {
    apiRequests: storage.apiRequests.size,
    authRequests: storage.authRequests.size,
    messageRequests: storage.messageRequests.size,
    waUserMessages: storage.waUserMessages.size,
    broadcastRequests: storage.broadcastRequests.size,
    socketConnections: storage.socketConnections.size,
    blacklistedIPs: storage.blacklistedIPs.size,
    blacklistedUsers: storage.blacklistedUsers.size,
    whitelistedIPs: storage.whitelistedIPs.size,
  };
};

// Get detailed blacklist info
const getBlacklistInfo = () => {
  const users = [];
  for (const [key, value] of storage.blacklistedUsers.entries()) {
    const [sessionId, userJid] = key.split(':');
    users.push({
      sessionId,
      userJid,
      reason: value.reason,
      until: value.until,
      remainingMs: value.until ? Math.max(0, value.until - Date.now()) : null,
    });
  }

  return {
    ips: Array.from(storage.blacklistedIPs),
    users,
  };
};

// Clear all rate limits (for admin use)
const clearAllLimits = () => {
  storage.apiRequests.clear();
  storage.authRequests.clear();
  storage.messageRequests.clear();
  storage.waUserMessages.clear();
  storage.broadcastRequests.clear();
  console.log('[ANTISPAM] All rate limits cleared');
};

/**
 * ===========================================
 * EXPRESS MIDDLEWARE SETUP
 * ===========================================
 */

// Main anti-spam middleware (combines multiple protection layers)
const antiSpamMiddleware = (req, res, next) => {
  const ip = getClientIP(req);

  // 1. Check blacklist first
  if (storage.blacklistedIPs.has(ip)) {
    return res.status(403).json({
      error: 'Access denied',
      message: 'IP anda telah di-blacklist',
      code: 'IP_BLACKLISTED'
    });
  }

  // 2. Skip rate limiting for whitelisted IPs
  if (storage.whitelistedIPs.has(ip)) {
    return next();
  }

  // 3. Apply general API rate limiting
  return apiRateLimiter(req, res, next);
};

/**
 * ===========================================
 * EXPORTS
 * ===========================================
 */
module.exports = {
  // Configuration
  CONFIG,
  
  // Middleware
  antiSpamMiddleware,
  apiRateLimiter,
  authRateLimiter,
  messageRateLimiter,
  broadcastRateLimiter,
  socketConnectionLimiter,
  
  // WhatsApp User Protection
  checkWAUserSpam,
  markAutoReplySent,
  isUserBlacklisted,
  blacklistUser,
  unblacklistUser,
  
  // IP Management
  blacklistIP,
  unblacklistIP,
  whitelistIP,
  unwhitelistIP,
  getClientIP,
  
  // Stats & Admin
  getStats,
  getBlacklistInfo,
  clearAllLimits,
  
  // Storage (for advanced use)
  storage,
};
