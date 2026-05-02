const express = require('express');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

// Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'lamplighter' });
});

// Register
app.post('/api/register', async (req, res) => {
  try {
    const { name, phone, belief, email } = req.body;
    if (!name || !phone || !belief) {
      return res.status(400).json({ error: 'Name, phone and belief are required.' });
    }
    const cleanPhone = phone.replace(/\s+/g, '').replace(/^0/, '+27');
    const { data: existing } = await supabase
      .from('users').select('*').eq('phone', cleanPhone).single();
    if (existing) {
      return res.json({ success: true, message: 'Welcome back!' });
    }
    const { error } = await supabase
      .from('users')
      .insert({ name: name.trim(), phone: cleanPhone, belief, email: email || null });
    if (error) throw error;
    return res.json({ success: true, message: 'Registered!' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => console.log(`Lamplighter running on port ${PORT}`));