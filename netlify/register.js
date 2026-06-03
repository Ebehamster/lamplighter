const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Approved WhatsApp welcome template (Content Template Builder → lamplighter_welcome)
const WELCOME_CONTENT_SID = 'HX1ff58d0f80f1ca79b7e7e3669713937a';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const { name, phone, belief, email } = JSON.parse(event.body);

    if (!name || !phone || !belief) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Name, phone and belief are required.' })
      };
    }

    const cleanPhone = normalizePhone(phone);

    console.log('REGISTER START. cleanPhone:', cleanPhone, 'belief:', belief);

    const { data: existing } = await supabase
      .from('users').select('*').eq('phone', cleanPhone).single();

    if (existing) {
      console.log('Returning user — sending Twilio for', cleanPhone);
      try {
        const result = await sendWelcomeWhatsApp(cleanPhone, name);
        console.log('Twilio SUCCESS (returning):', result.sid, 'status:', result.status);
      } catch (err) {
        console.error('Twilio (welcome back) FAILED:', err.message);
      }

      return {
        statusCode: 200,
        body: JSON.stringify({ success: true, message: 'Welcome back!' })
      };
    }

    const { error } = await supabase
      .from('users')
      .insert({ name: name.trim(), phone: cleanPhone, belief, email: email || null });

    if (error) throw error;

    console.log('New user — sending Twilio for', cleanPhone);
    try {
      const result = await sendWelcomeWhatsApp(cleanPhone, name);
      console.log('Twilio SUCCESS (new):', result.sid, 'status:', result.status);
    } catch (err) {
      console.error('Twilio (new user) FAILED:', err.message);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, message: 'Registered!' })
    };
  } catch (err) {
    console.error('Handler error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message || 'Something went wrong' })
    };
  }
};

// Normalise a phone number to E.164. Robust for South African inputs,
// and passes through already-valid international (+) numbers.
function normalizePhone(raw) {
  const trimmed = String(raw).replace(/\s+/g, '');

  // Already in +E.164 form
  if (trimmed.startsWith('+')) {
    let digits = trimmed.slice(1).replace(/\D/g, '');
    // Fix the common SA mistake: "+27 0XXXXXXXXX" -> drop the stray 0
    if (digits.startsWith('270')) digits = '27' + digits.slice(3);
    return '+' + digits;
  }

  let digits = trimmed.replace(/\D/g, '');

  if (digits.startsWith('00')) digits = digits.slice(2);   // 00 intl prefix

  if (digits.startsWith('27')) {                            // 27XXXXXXXXX
    let rest = digits.slice(2);
    if (rest.startsWith('0')) rest = rest.slice(1);         // strip stray 0
    return '+27' + rest;
  }

  if (digits.startsWith('0')) return '+27' + digits.slice(1); // 0XXXXXXXXX (SA local)

  return '+27' + digits;                                      // bare subscriber number
}

// Sends the approved WhatsApp welcome template (business-initiated).
// Uses ContentSid + ContentVariables — NOT Body (Body is rejected outside the 24h window).
async function sendWelcomeWhatsApp(phone, name) {
  const firstName = name.trim().split(' ')[0];

  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_NUMBER; // e.g. whatsapp:+12524216525

  const auth = Buffer.from(`${sid}:${token}`).toString('base64');

  const params = new URLSearchParams();
  params.append('From', from);
  params.append('To', `whatsapp:${phone}`);
  params.append('ContentSid', WELCOME_CONTENT_SID);
  params.append('ContentVariables', JSON.stringify({ '1': firstName }));

  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;

  console.log('Twilio fetch (template): from', from, 'to', `whatsapp:${phone}`);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params.toString()
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(`Twilio ${response.status}: ${data.message || JSON.stringify(data)}`);
  }

  return data;
}
