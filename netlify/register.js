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

    const { data: existing } = await supabase
      .from('users').select('*').eq('phone', cleanPhone).single();

    if (existing) {
      return {
        statusCode: 200,
        body: JSON.stringify({ success: true, message: 'Welcome back!' })
      };
    }

    const { error } = await supabase
      .from('users')
      .insert({ name: name.trim(), phone: cleanPhone, belief, email: email || null });

    if (error) throw error;

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, message: 'Registered!' })
    };

  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Something went wrong.' })
    };
  }
};