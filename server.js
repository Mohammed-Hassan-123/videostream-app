const express = require('express');
const path = require('path');
const fs = require('fs');
const morgan = require('morgan');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const multer = require('multer');
const { Pool } = require('pg');
const Minio = require('minio');

const app = express();
const PORT = 3000;

// ─── MinIO Client ─────────────────────────────────────────────────────────────
const minioClient = new Minio.Client({
  endPoint:  process.env.MINIO_ENDPOINT,
  port:      parseInt(process.env.MINIO_PORT),
  useSSL:    false,
  accessKey: process.env.MINIO_ACCESS_KEY,
  secretKey: process.env.MINIO_SECRET_KEY
});
const BUCKET = process.env.MINIO_BUCKET;

// ─── PostgreSQL Pool ──────────────────────────────────────────────────────────
const pool = new Pool({
  host:     process.env.PG_HOST,
  port:     parseInt(process.env.PG_PORT),
  database: process.env.PG_DATABASE,
  user:     process.env.PG_USER,
  password: process.env.PG_PASSWORD
});

// ─── Logs ─────────────────────────────────────────────────────────────────────
const LOG_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);

const accessLogStream = fs.createWriteStream(path.join(LOG_DIR, 'access.log'), { flags: 'a' });
const errorLogStream  = fs.createWriteStream(path.join(LOG_DIR, 'error.log'),  { flags: 'a' });
const auditLogStream  = fs.createWriteStream(path.join(LOG_DIR, 'audit.log'),  { flags: 'a' });

function logError(err, req) {
  const line = `[${new Date().toISOString()}] ${req.method} ${req.url} — ${err.message}\n`;
  errorLogStream.write(line);
  console.error(line.trim());
}

function logAudit(action, detail, req) {
  const line = `[${new Date().toISOString()}] user=${req.session?.user?.username} action=${action} detail="${detail}"\n`;
  auditLogStream.write(line);
  console.log(line.trim());
}

// ─── Multer — video upload (memory) ──────────────────────────────────────────
const videoUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'video/mp4') cb(null, true);
    else cb(new Error('Only MP4 files allowed'));
  },
  limits: { fileSize: 500 * 1024 * 1024 }
});

// ─── Multer — thumbnail upload (memory) ──────────────────────────────────────
const thumbUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files allowed'));
  },
  limits: { fileSize: 5 * 1024 * 1024 }
});

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(morgan('combined', { stream: accessLogStream }));
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.set('trust proxy', 1);
app.use(session({
  store: new pgSession({
    pool: pool,
    tableName: 'session'
  }),
  secret: 'videostream-secret-2026',
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000,
    secure: false,
    httpOnly: true
  }
}));

app.use(express.static('public'));

// ─── Auth Middleware ──────────────────────────────────────────────────────────
function requireLogin(req, res, next) {
  if (req.session && req.session.user) return next();
  res.redirect('/login');
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.user && req.session.user.role === 'admin') return next();
  res.status(403).sendFile(path.join(__dirname, 'public', '403.html'));
}

// ─── Public Routes ────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/about', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'about.html'));
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ─── Auth API ─────────────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await pool.query(
      'SELECT * FROM users WHERE username = $1 AND password = $2',
      [username, password]
    );
    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid username or password' });
    const user = result.rows[0];
    req.session.user = { id: user.id, username: user.username, role: user.role, joinedDate: user.joined_date };
    res.json({ success: true, role: user.role });
  } catch (err) {
    logError(err, req);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/signup', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (username === 'Admin') return res.status(400).json({ error: 'Username not available' });
  try {
    const existing = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
    if (existing.rows.length > 0) return res.status(400).json({ error: 'Username already taken' });
    const result = await pool.query(
      'INSERT INTO users (username, password, role) VALUES ($1, $2, $3) RETURNING *',
      [username, password, 'client']
    );
    const user = result.rows[0];
    req.session.user = { id: user.id, username: user.username, role: user.role, joinedDate: user.joined_date };
    res.json({ success: true, role: 'client' });
  } catch (err) {
    logError(err, req);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// ─── Session Info ─────────────────────────────────────────────────────────────
app.get('/api/me', (req, res) => {
  if (req.session.user) res.json(req.session.user);
  else res.json(null);
});

// ─── Account Settings ─────────────────────────────────────────────────────────
app.get('/account', requireLogin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'account.html'));
});

app.post('/api/reset-password', requireLogin, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'All fields required' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  try {
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [req.session.user.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const user = result.rows[0];
    if (user.password !== currentPassword) return res.status(401).json({ error: 'Current password incorrect' });
    await pool.query('UPDATE users SET password = $1 WHERE id = $2', [newPassword, user.id]);
    res.json({ success: true });
  } catch (err) {
    logError(err, req);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Library ──────────────────────────────────────────────────────────────────
app.get('/videos', requireLogin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'library.html'));
});

app.get('/api/videos', requireLogin, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM videos ORDER BY id ASC');
    res.json(result.rows);
  } catch (err) {
    logError(err, req);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Player ───────────────────────────────────────────────────────────────────
app.get('/play', requireLogin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'player.html'));
});

// ─── Video Streaming ──────────────────────────────────────────────────────────
app.get('/video/:filename', requireLogin, async (req, res) => {
  const objectKey = `videos/${req.params.filename}`;
  try {
    const stat = await minioClient.statObject(BUCKET, objectKey);
    const fileSize = stat.size;
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = Math.min(parts[1] ? parseInt(parts[1], 10) : fileSize - 1, fileSize - 1);
      const chunkSize = end - start + 1;
      res.writeHead(206, {
        'Content-Range':  `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges':  'bytes',
        'Content-Length': chunkSize,
        'Content-Type':   'video/mp4'
      });
      const stream = await minioClient.getPartialObject(BUCKET, objectKey, start, chunkSize);
      stream.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type':   'video/mp4',
        'Accept-Ranges':  'bytes'
      });
      const stream = await minioClient.getObject(BUCKET, objectKey);
      stream.pipe(res);
    }
  } catch (err) {
    if (err.code === 'NoSuchKey') return res.status(404).json({ error: 'Video not found' });
    logError(err, req);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Thumbnail Serving ────────────────────────────────────────────────────────
app.get('/thumbnails/*', requireLogin, async (req, res) => {
  const key = req.params[0];
  try {
    const stat = await minioClient.statObject(BUCKET, key);
    res.setHeader('Content-Type', stat.metaData?.['content-type'] || 'image/jpeg');
    const stream = await minioClient.getObject(BUCKET, key);
    stream.pipe(res);
  } catch (err) {
    if (err.code === 'NoSuchKey') return res.status(404).end();
    logError(err, req);
    res.status(500).end();
  }
});

// ─── Admin Inventory ──────────────────────────────────────────────────────────
app.get('/videos/admin', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.post('/api/videos/rename', requireAdmin, async (req, res) => {
  const { id, displayName } = req.body;
  if (!id || !displayName) return res.status(400).json({ error: 'ID and display name required' });
  try {
    const result = await pool.query('UPDATE videos SET display_name = $1 WHERE id = $2 RETURNING *', [displayName, parseInt(id)]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Video not found' });
    logAudit('RENAME_VIDEO', `id=${id} newName=${displayName}`, req);
    res.json({ success: true });
  } catch (err) {
    logError(err, req);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/videos/upload', requireAdmin, (req, res, next) => {
  videoUpload.single('video')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: err.message });
    }
    if (err) {
      return res.status(400).json({ error: err.message });
    }
    next();
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No video file uploaded' });
  const objectKey = `videos/${req.file.originalname}`;
  try {
    await minioClient.putObject(BUCKET, objectKey, req.file.buffer, req.file.size, { 'Content-Type': 'video/mp4' });
    const sizeMB = (req.file.size / (1024 * 1024)).toFixed(1) + ' MB';
    const result = await pool.query(
      'INSERT INTO videos (filename, display_name, size) VALUES ($1, $2, $3) RETURNING *',
      [req.file.originalname, req.file.originalname.replace('.mp4', ''), sizeMB]
    );
    logAudit('UPLOAD_VIDEO', req.file.originalname, req);
    res.json({ success: true, video: result.rows[0] });
  } catch (err) {
    logError(err, req);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/thumbnails/upload', requireAdmin, thumbUpload.single('thumbnail'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No thumbnail uploaded' });
  const { videoId } = req.body;
  try {
    const existing = await pool.query('SELECT thumbnail_key FROM videos WHERE id = $1', [parseInt(videoId)]);
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Video not found' });
    if (existing.rows[0].thumbnail_key) {
      await minioClient.removeObject(BUCKET, existing.rows[0].thumbnail_key);
    }
    const ext = path.extname(req.file.originalname);
    const thumbKey = `thumbs/thumb_${Date.now()}${ext}`;
    await minioClient.putObject(BUCKET, thumbKey, req.file.buffer, req.file.size, { 'Content-Type': req.file.mimetype });
    await pool.query('UPDATE videos SET thumbnail_key = $1 WHERE id = $2', [thumbKey, parseInt(videoId)]);
    res.json({ success: true, thumbnail: thumbKey });
  } catch (err) {
    logError(err, req);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/videos/:id', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM videos WHERE id = $1', [parseInt(req.params.id)]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Video not found' });
    const video = result.rows[0];
    await minioClient.removeObject(BUCKET, `videos/${video.filename}`);
    if (video.thumbnail_key) {
      await minioClient.removeObject(BUCKET, video.thumbnail_key);
    }
    await pool.query('DELETE FROM videos WHERE id = $1', [parseInt(req.params.id)]);
    logAudit('DELETE_VIDEO', video.filename, req);
    res.json({ success: true });
  } catch (err) {
    logError(err, req);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/thumbnails/:videoId', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT thumbnail_key FROM videos WHERE id = $1', [parseInt(req.params.videoId)]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Video not found' });
    const { thumbnail_key } = result.rows[0];
    if (thumbnail_key) {
      await minioClient.removeObject(BUCKET, thumbnail_key);
      await pool.query('UPDATE videos SET thumbnail_key = NULL WHERE id = $1', [parseInt(req.params.videoId)]);
    }
    res.json({ success: true });
  } catch (err) {
    logError(err, req);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Global Error Handler ─────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  logError(err, req);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`VideoStream running at http://localhost:${PORT}`);
});
