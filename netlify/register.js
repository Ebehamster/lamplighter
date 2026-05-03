const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

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

    const cleanPhone = phone.replace(/\s+/g, '').replace(/^0/, '+27');

    console.log('REGISTER START. cleanPhone:', cleanPhone, 'belief:', belief);

    const { data: existing } = await supabase
      .from('users').select('*').eq('phone', cleanPhone).single();

    if (existing) {
      console.log('Returning user — sending Twilio for', cleanPhone);
      try {
        const result = await sendWelcomeWhatsApp(cleanPhone, name, belief, true);
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
      const result = await sendWelcomeWhatsApp(cleanPhone, name, belief, false);
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

async function sendWelcomeWhatsApp(phone, name, belief, isReturning) {
  const firstName = name.trim().split(' ')[0];

  const body = isReturning
    ? `Welcome back, ${firstName}. 🕯️\n\nYour light is still here, waiting. Whenever you're ready, just send a message — I'm with you.`
    : `Hi ${firstName}, this is Lamplighter. 🕯️\n\nYour light is on. I'm here whenever you need a moment of calm, reflection, or quiet support — shaped by your ${belief} path.\n\nWhen you're ready, send me a message. I'm listening.`;

  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_NUMBER;

  const auth = Buffer.from(`${sid}:${token}`).toString('base64');

  const params = new URLSearchParams();
  params.append('From', from);
  params.append('To', `whatsapp:${phone}`);
  params.append('Body', body);

  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;

  console.log('Twilio fetch: from', from, 'to', `whatsapp:${phone}`);

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