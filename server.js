// OpsDeck V2 — Property Maintenance Operations Platform (multi-tenant)
const express = require('express');
const session = require('express-session');
const path = require('path');

require('./src/db');                          // runs V2 migration
const seed = require('./src/seed');
const seedV2 = require('./src/seed2');
const { router: api, generatePMWorkOrders } = require('./src/api');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'opsdeck-dev-secret-change-me',
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 24 * 14 }
}));

app.use('/api', api);
app.use('/uploads', express.static(process.env.UPLOAD_DIR || path.join(__dirname, 'uploads')));
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Something went wrong on the server' }); });

seed(false);          // V1 demo data on fresh installs (migration backfills org ids)
seedV2();             // V2 supplement: second org, quotes, viewer, completion requirements
generatePMWorkOrders();
setInterval(generatePMWorkOrders, 6 * 60 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`OpsDeck V2 running on port ${PORT}`));
