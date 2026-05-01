// ================================================================
// LAMPLIGHTER BACKEND
// Stack: Node.js + Express + Supabase + Twilio + OpenAI
// ================================================================

// ----------------------------------------------------------------
// FILE STRUCTURE
// ----------------------------------------------------------------
// lamplighter-backend/
// ├── server.js          ← main entry (this file)
// ├── .env               ← secrets (never commit)
// ├── package.json
// ├── routes/
// │   ├── register.js    ← user registration
// │   └── webhook.js     ← Twilio WhatsApp inbound
// ├── services/
// │   ├── db.js          ← Supabase client
// │   ├── whatsapp.js    ← Twilio outbound sender
// │   └── ai.js          ← OpenAI faith engine
// └── prompts/
//     └── faithPrompts.js ← per-belief system prompts

// ================================================================
// package.json
// ================================================================
/*
{
  "name": "lamplighter-backend",
  "version": "1.0.0",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "cors": "^2.8.5",
    "dotenv": "^16.3.1",
    "@supabase/supabase-js": "^2.38.0",
    "twilio": "^4.19.0",
    "openai": "^4.20.0",
    "body-parser": "^1.20.2",
    "express-rate-limit": "^7.1.5"
  },
  "devDependencies": {
    "nodemon": "^3.0.2"
  }
}
*/

// ================================================================
// .env (copy this, fill in your real values)
// ================================================================
/*
PORT=3000
NODE_ENV=production

# Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-role-key

# Twilio
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your-auth-token
TWILIO_WHATSAPP_NUMBER=whatsapp:+14155238886

# OpenAI
OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# App
APP_URL=https://lamplighter.app
WEBHOOK_SECRET=your-random-secret-string
*/

// ================================================================
// server.js — MAIN ENTRY POINT
// ================================================================

require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const bodyParser = require('body-parser');
const rateLimit  = require('express-rate-limit');

const app = express();

// ── Middleware ──────────────────────────────────────────────────
app.use(cors({ origin: ['https://lamplighter.app', 'http://localhost:3000'] }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false })); // Twilio sends urlencoded

// Rate limiting — protect against abuse
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
app.use('/api/', limiter);

// ── Health check ────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'lamplighter' }));

// ── Routes ──────────────────────────────────────────────────────
app.use('/api/register', require('./routes/register'));
app.use('/webhook',      require('./routes/webhook'));

// ── Start ───────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🕯️  Lamplighter running on port ${PORT}`));

module.exports = app;


// ================================================================
// services/db.js — SUPABASE CLIENT + SCHEMA
// ================================================================
/*

-- Run this SQL in your Supabase dashboard → SQL Editor

CREATE TABLE users (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name          TEXT NOT NULL,
  phone         TEXT NOT NULL UNIQUE,  -- E.164 format e.g. +27821234567
  belief        TEXT NOT NULL,         -- christian|muslim|jewish|hindu|buddhist|spiritual|interfaith
  email         TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  last_active   TIMESTAMPTZ DEFAULT NOW(),
  is_active     BOOLEAN DEFAULT TRUE,
  message_count INTEGER DEFAULT 0
);

CREATE TABLE conversations (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content    TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE safety_flags (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id    UUID REFERENCES users(id),
  message    TEXT,
  flag_type  TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast phone lookup (used on every message)
CREATE INDEX idx_users_phone ON users(phone);
CREATE INDEX idx_conv_user   ON conversations(user_id, created_at DESC);

-- Row-level security
ALTER TABLE users          ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations  ENABLE ROW LEVEL SECURITY;
ALTER TABLE safety_flags   ENABLE ROW LEVEL SECURITY;

*/

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

// Get user by WhatsApp phone number
async function getUserByPhone(phone) {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('phone', phone)
    .single();
  if (error && error.code !== 'PGRST116') throw error;
  return data;
}

// Create new user
async function createUser({ name, phone, belief, email }) {
  const { data, error } = await supabase
    .from('users')
    .insert({ name, phone, belief, email })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Save a message to conversation history
async function saveMessage(userId, role, content) {
  const { error } = await supabase
    .from('conversations')
    .insert({ user_id: userId, role, content });
  if (error) throw error;
}

// Get last N messages for context (conversation memory)
async function getHistory(userId, limit = 10) {
  const { data, error } = await supabase
    .from('conversations')
    .select('role, content')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data || []).reverse(); // oldest first for OpenAI
}

// Update last active timestamp + increment message count
async function updateActivity(userId) {
  await supabase
    .from('users')
    .update({ last_active: new Date().toISOString(), message_count: supabase.rpc('increment', { x: 1 }) })
    .eq('id', userId);
}

// Flag a message for safety review
async function flagMessage(userId, message, flagType) {
  await supabase
    .from('safety_flags')
    .insert({ user_id: userId, message, flag_type: flagType });
}

module.exports = { getUserByPhone, createUser, saveMessage, getHistory, updateActivity, flagMessage };


// ================================================================
// prompts/faithPrompts.js — FAITH-ALIGNED SYSTEM PROMPTS
// ================================================================

const BASE = `You are Lamplighter — a deeply empathetic, spiritually grounded AI companion.

Your role is to provide emotional support and spiritual guidance through WhatsApp conversations.

CORE PRINCIPLES:
- You are warm, present, and genuinely caring — never robotic or scripted
- You listen deeply before offering guidance
- You ask ONE thoughtful follow-up question per response (never more)
- You keep responses concise — 3 to 5 sentences max unless more is truly needed
- You NEVER diagnose, prescribe, or provide medical/legal/financial advice
- You NEVER replace professional therapy — you complement it
- If someone expresses suicidal ideation or crisis, respond with compassion AND provide SADAG: 0800 567 567
- You end responses with gentle warmth, never abruptly

SAFETY TRIGGERS — if you detect these, always include crisis resources:
- Suicidal thoughts or self-harm
- Domestic violence or abuse
- Severe mental health crisis
- Child endangerment

TONE: Like a wise, warm friend who has walked through darkness and found light. Never preachy. Never clinical. Never performative.

The user's name is {{NAME}}.`;

const FAITH_PROMPTS = {

  christian: `${BASE}

FAITH CONTEXT — Christianity:
- Draw from both Old and New Testament as appropriate
- Reference Jesus's teachings, parables, and character
- Use scripture naturally — cite it (e.g. John 3:16) but never lecture
- Acknowledge the full spectrum: Catholic, Protestant, Pentecostal, Orthodox — ask if relevant
- Core themes: grace, forgiveness, love, redemption, the peace that passes understanding
- Prayer is central — offer to pray with them or suggest prayer naturally
- Avoid religious clichés like "everything happens for a reason" — be real
- Favourite touchstones: Psalms for grief, Romans 8 for perseverance, Philippians 4 for anxiety`,

  muslim: `${BASE}

FAITH CONTEXT — Islam:
- Open with Assalamu alaikum when appropriate
- Draw from the Quran and Hadith — cite surahs (e.g. Al-Baqarah 2:286)
- Core themes: tawakkul (trust in Allah), sabr (patience), tawbah (repentance), shukr (gratitude)
- Acknowledge Sunni, Shia, Sufi traditions — be inclusive
- Dua (supplication) is powerful — reference it naturally
- Ramadan, Eid, prayer times may be contextually relevant
- Never make assumptions about practice level — meet them where they are
- Favourite touchstones: Al-Baqarah for hardship, Ash-Sharh for relief, Al-Imran for strength`,

  jewish: `${BASE}

FAITH CONTEXT — Judaism:
- Draw from Torah, Talmud, and Jewish wisdom traditions
- Reference relevant concepts: teshuvah (return/repentance), chesed (loving kindness), tikun olam (repair of the world)
- Acknowledge Reform, Conservative, Orthodox, and secular Jewish identities
- The Jewish calendar and holidays may provide meaningful context
- Lamentations and Psalms for grief; Proverbs for wisdom
- Community (kehillah) is central to Jewish wellbeing
- Shabbat as rest and renewal is a powerful touchstone
- Hebrew phrases used naturally where fitting (e.g. B'ezrat Hashem — with God's help)`,

  hindu: `${BASE}

FAITH CONTEXT — Hinduism:
- Draw from the Bhagavad Gita, Upanishads, and broader Vedic tradition
- Core concepts: dharma (righteous duty), karma, moksha (liberation), ahimsa (non-violence)
- The Gita's teaching on detachment from outcomes (nishkama karma) is especially relevant for anxiety
- Acknowledge the breadth of Hindu practice — from devotional bhakti to philosophical advaita
- Mantras, meditation, and puja may be relevant touchstones
- The divine is often personal — ask about their deity or tradition if relevant
- Favourite touchstones: Bhagavad Gita Chapter 2 for equanimity, Chapter 6 for the mind`,

  buddhist: `${BASE}

FAITH CONTEXT — Buddhism:
- Draw from the Buddha's core teachings: Four Noble Truths, Eightfold Path, impermanence
- Core themes: suffering (dukkha), compassion (karuna), mindfulness (sati), non-attachment
- Acknowledge Theravada, Mahayana, Zen, and Tibetan Buddhist traditions
- Meditation and breath awareness are natural recommendations
- The teaching of impermanence is profoundly comforting for grief and anxiety
- Loving-kindness (metta) meditation can be gently suggested
- Favourite touchstones: the parable of the mustard seed for grief, the Dhammapada for wisdom`,

  spiritual: `${BASE}

FAITH CONTEXT — Spiritual (non-religious):
- The user is spiritually aware but not tied to a specific organised religion
- Draw from universal spiritual wisdom: interconnectedness, presence, inner light, the soul
- Reference a range of traditions lightly — offer what resonates, not what prescribes
- Nature, mindfulness, breathwork, and intentionality are powerful touchstones
- Avoid specifically religious language unless the user introduces it
- Core themes: inner wisdom, self-compassion, meaning-making, the present moment
- You are a guide to their own inner knowing — not an external authority`,

  interfaith: `${BASE}

FAITH CONTEXT — Interfaith / Exploring:
- The user may be between traditions, questioning, or drawing from multiple paths
- Hold space for doubt, curiosity, and spiritual searching — these are sacred too
- Ask gently what resonates with them rather than assuming
- Draw from multiple traditions as feels appropriate — always ask first
- Core themes: the universal search for meaning, love, and connection that runs through all faiths
- Be an open, non-dogmatic companion — a light, not a doctrine`

};

function getSystemPrompt(belief, userName) {
  const prompt = FAITH_PROMPTS[belief] || FAITH_PROMPTS.spiritual;
  return prompt.replace('{{NAME}}', userName || 'friend');
}

module.exports = { getSystemPrompt };


// ================================================================
// services/ai.js — OPENAI FAITH ENGINE
// ================================================================

const OpenAI = require('openai');
const { getSystemPrompt } = require('../prompts/faithPrompts');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Safety keywords that trigger crisis resources
const CRISIS_KEYWORDS = [
  'suicide', 'kill myself', 'end my life', 'want to die', 'don\'t want to live',
  'self harm', 'hurt myself', 'no reason to live', 'better off dead', 'cut myself'
];

const CRISIS_RESOURCES = `\n\n🆘 *If you're in crisis, please reach out:*\n• SADAG: 0800 567 567 (24hrs)\n• SMS: 31393\n• Emergency: 10111\n\nYou are not alone. 🕯️`;

function detectCrisis(message) {
  const lower = message.toLowerCase();
  return CRISIS_KEYWORDS.some(kw => lower.includes(kw));
}

async function generateResponse(user, userMessage, history) {
  const isCrisis = detectCrisis(userMessage);

  const systemPrompt = getSystemPrompt(user.belief, user.name);

  // Build messages array: system + history + new message
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: userMessage }
  ];

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages,
    max_tokens: 400,
    temperature: 0.75,  // warm and natural, not robotic
    presence_penalty: 0.3,  // avoid repetition
    frequency_penalty: 0.3
  });

  let response = completion.choices[0].message.content.trim();

  // Append crisis resources if needed
  if (isCrisis) response += CRISIS_RESOURCES;

  return { response, isCrisis };
}

module.exports = { generateResponse, detectCrisis };


// ================================================================
// services/whatsapp.js — TWILIO OUTBOUND SENDER
// ================================================================

const twilio = require('twilio');

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

async function sendWhatsApp(to, message) {
  // Ensure number is in WhatsApp format
  const toFormatted = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;

  const msg = await client.messages.create({
    from: process.env.TWILIO_WHATSAPP_NUMBER,
    to: toFormatted,
    body: message
  });

  return msg.sid;
}

// Send the welcome message when user first registers
async function sendWelcomeMessage(user) {
  const messages = {
    christian:  `✝️ Peace be with you, ${user.name}. I'm Lamplighter — your spiritual companion, always here. Share anything that's on your heart, day or night. What's weighing on you today?`,
    muslim:     `☪️ Assalamu alaikum, ${user.name}. I'm Lamplighter — here to walk alongside you with faith and care. Share what's on your heart, whenever you're ready. How are you doing today?`,
    jewish:     `✡️ Shalom, ${user.name}. I'm Lamplighter — a warm companion for your spirit, always present. Share what's on your mind whenever you're ready. How are you today?`,
    hindu:      `🕉️ Namaste, ${user.name}. I'm Lamplighter — here to support your inner journey with wisdom and care. Share whatever is on your heart. How are you feeling today?`,
    buddhist:   `☸️ Hello, ${user.name}. I'm Lamplighter — a calm presence for your spiritual journey. Share anything that's arising for you. How are you in this moment?`,
    spiritual:  `✨ Hello, ${user.name}. I'm Lamplighter — here to walk alongside you on your spiritual path. No labels, no judgement. Share whatever's on your mind. How are you today?`,
    interfaith: `🌍 Hello, ${user.name}. I'm Lamplighter — open to all paths, here for yours. Share what's on your heart whenever you're ready. How are you feeling today?`
  };

  const welcome = messages[user.belief] || messages.spiritual;
  await sendWhatsApp(user.phone, `🕯️ *Lamplighter*\n\n${welcome}`);
}

module.exports = { sendWhatsApp, sendWelcomeMessage };


// ================================================================
// routes/register.js — USER REGISTRATION ENDPOINT
// ================================================================

const router    = require('express').Router();
const db        = require('../services/db');
const wa        = require('../services/whatsapp');

// POST /api/register
router.post('/', async (req, res) => {
  try {
    const { name, phone, belief, email } = req.body;

    // Validate required fields
    if (!name || !phone || !belief) {
      return res.status(400).json({ error: 'name, phone, and belief are required.' });
    }

    // Normalise phone: strip spaces, ensure +27 format
    const cleanPhone = phone.replace(/\s+/g, '').replace(/^0/, '+27');

    // Check if already registered
    const existing = await db.getUserByPhone(cleanPhone);
    if (existing) {
      // Re-send welcome message and return
      await wa.sendWelcomeMessage(existing);
      return res.json({ success: true, message: 'Welcome back! Check your WhatsApp.', existing: true });
    }

    // Create user
    const user = await db.createUser({
      name: name.trim(),
      phone: cleanPhone,
      belief,
      email: email?.trim() || null
    });

    // Send WhatsApp welcome message
    await wa.sendWelcomeMessage(user);

    return res.json({ success: true, message: 'Registered! Check your WhatsApp.' });

  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;


// ================================================================
// routes/webhook.js — TWILIO WHATSAPP INBOUND WEBHOOK
// ================================================================

const router = require('express').Router();
const db     = require('../services/db');
const ai     = require('../services/ai');
const wa     = require('../services/whatsapp');

// POST /webhook/whatsapp
// Twilio calls this every time a user sends a WhatsApp message
router.post('/whatsapp', async (req, res) => {

  // Acknowledge Twilio immediately (must respond within 15s)
  res.status(200).send('<Response></Response>');

  try {
    const incomingMsg = (req.body.Body || '').trim();
    const fromNumber  = req.body.From; // format: whatsapp:+27821234567
    const cleanPhone  = fromNumber.replace('whatsapp:', '');

    if (!incomingMsg) return;

    // Look up user
    const user = await db.getUserByPhone(cleanPhone);

    if (!user) {
      // Unknown user — prompt them to register
      await wa.sendWhatsApp(fromNumber,
        `🕯️ *Lamplighter*\n\nIt looks like you haven't registered yet. Visit lamplighter.app to get started — it only takes 60 seconds. ✨`
      );
      return;
    }

    // Handle commands
    if (incomingMsg.toLowerCase() === 'stop') {
      await wa.sendWhatsApp(fromNumber, `You've been unsubscribed from Lamplighter. We'll miss you. 🕯️\n\nReply START anytime to return.`);
      return;
    }

    if (incomingMsg.toLowerCase() === 'start') {
      await wa.sendWelcomeMessage(user);
      return;
    }

    if (incomingMsg.toLowerCase() === 'help') {
      await wa.sendWhatsApp(fromNumber,
        `🕯️ *Lamplighter Help*\n\n• Just message anything on your heart — I'm here\n• STOP — unsubscribe\n• START — re-activate\n\nFor support: hello@lamplighter.app`
      );
      return;
    }

    // Save user's message to history
    await db.saveMessage(user.id, 'user', incomingMsg);

    // Get conversation history for context (last 10 messages)
    const history = await db.getHistory(user.id, 10);

    // Check for crisis content
    const isCrisis = ai.detectCrisis(incomingMsg);
    if (isCrisis) {
      await db.flagMessage(user.id, incomingMsg, 'crisis');
    }

    // Generate AI response
    const { response } = await ai.generateResponse(user, incomingMsg, history);

    // Save AI response to history
    await db.saveMessage(user.id, 'assistant', response);

    // Update user activity
    await db.updateActivity(user.id);

    // Send response via WhatsApp
    await wa.sendWhatsApp(fromNumber, response);

  } catch (err) {
    console.error('Webhook error:', err);
    // Don't re-throw — Twilio already got 200
  }
});

module.exports = router;


// ================================================================
// DEPLOYMENT GUIDE
// ================================================================
/*

── STEP 1: SET UP SUPABASE ──────────────────────────────────────
1. Go to supabase.com → New project
2. Copy your Project URL and service_role key → paste into .env
3. Open SQL Editor → run the CREATE TABLE queries above
4. Done ✓

── STEP 2: SET UP TWILIO ────────────────────────────────────────
1. Go to twilio.com → create account
2. Console → Messaging → WhatsApp Sandbox (for testing)
3. OR go live: apply for WhatsApp Business API
4. Copy Account SID + Auth Token → paste into .env
5. WhatsApp number: +14155238886 (sandbox) → paste as TWILIO_WHATSAPP_NUMBER
6. Webhook URL (set in Twilio console):
   https://yourdomain.com/webhook/whatsapp
7. Done ✓

── STEP 3: SET UP OPENAI ────────────────────────────────────────
1. Go to platform.openai.com → API Keys
2. Create new key → paste into .env as OPENAI_API_KEY
3. Recommended model: gpt-4o (best quality)
4. Set a monthly spend limit in OpenAI dashboard
5. Done ✓

── STEP 4: DEPLOY THE BACKEND ───────────────────────────────────
Option A — Railway (easiest, ~$5/month):
  1. railway.app → New project → Deploy from GitHub
  2. Add environment variables from .env
  3. Done — Railway gives you a URL like yourapp.railway.app

Option B — Render (free tier available):
  1. render.com → New Web Service → Connect GitHub
  2. Add environment variables
  3. Done

Option C — VPS (Digital Ocean, $6/month):
  1. Create Ubuntu droplet
  2. Install Node.js 20+
  3. Clone your repo, npm install
  4. Use PM2 to keep it running: pm2 start server.js
  5. Use Nginx as reverse proxy

── STEP 5: CONNECT WEBSITE TO BACKEND ──────────────────────────
In your index.html, the handleSubmit function already POSTs to /api/register.
Update the fetch URL to your deployed backend:

  fetch('https://yourapp.railway.app/api/register', { ... })

── STEP 6: TEST ─────────────────────────────────────────────────
1. Register via lamplighter.app
2. Open WhatsApp → message the Twilio sandbox number
3. Watch the response arrive within 5 seconds
4. 🕯️ You're live.

── ESTIMATED MONTHLY COSTS (1,000 active users) ─────────────────
• Supabase:    Free tier → $0
• Railway:     ~$5/month
• Twilio:      ~$50 (WhatsApp at $0.005/msg, 10 msgs/user/day)
• OpenAI:      ~$40 (gpt-4o at ~$0.04/conversation)
• Domain:      $14/year
• TOTAL:       ~$95/month for 1,000 active users
• Per user:    $0.095/month → break even at $0.10/user/month

*/
