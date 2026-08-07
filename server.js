// OpsDeck — Property Maintenance Operations Platform
const express = require('express');
const session = require('express-session');
const path = require('path');

require('./src/db');
const seed = require('./src/seed');
const { router: api, generatePMWorkOrders } = require('./src/api');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'opsdeck-dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 24 * 14 }
}));

app.use('/api', api);
app.use('/uploads', express.static(process.env.UPLOAD_DIR || path.join(__dirname, 'uploads')));
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server' });
});

// Seed demo data on first boot, then generate any due preventive-maintenance work orders.
seed(false);
generatePMWorkOrders();
setInterval(generatePMWorkOrders, 6 * 60 * 60 * 1000); // re-check every 6 hours

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`OpsDeck running on port ${PORT}`));
