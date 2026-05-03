const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
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

    const { data: existing } = await supabase
      .from('users').select('*').eq('phone', cleanPhone).single();

    if (existing) {
      // Send "welcome back" WhatsApp message but don't fail registration if it errors
      sendWelcomeWhatsApp(cleanPhone, name, belief, true).catch(err =>
        console.error('Twilio (welcome back) failed:', err.message)
      );

      return {
        statusCode: 200,
        body: JSON.stringify({ success: true, message: 'Welcome back!' })
      };
    }

    const { error } = await supabase
      .from('users')
      .insert({ name: name.trim(), phone: cleanPhone, belief, email: email || null });

    if (error) throw error;

    // Send welcome WhatsApp — don't fail registration if Twilio errors
    sendWelcomeWhatsApp(cleanPhone, name, belief, false).catch(err =>
      console.error('Twilio (new user) failed:', err.message)
    );

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, message: 'Registered!' })
    };
  } catch (err) {
    console.error(err);
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

  return twilioClient.messages.create({
    from: process.env.TWILIO_WHATSAPP_NUMBER,
    to: `whatsapp:${phone}`,
    body
  });
}