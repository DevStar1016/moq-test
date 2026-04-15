import cors from 'cors'
import express from 'express'
import multer from 'multer'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'
import Database from 'better-sqlite3'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const PORT = Number(process.env.PORT || 4000)
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data')
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads')
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'ads.sqlite')

fs.mkdirSync(DATA_DIR, { recursive: true })
fs.mkdirSync(UPLOADS_DIR, { recursive: true })

const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.exec(`
  CREATE TABLE IF NOT EXISTS ads (
    id TEXT PRIMARY KEY,
    directory_name TEXT NOT NULL,
    title TEXT NOT NULL,
    original_filename TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    public_path TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ads_created_at ON ads(created_at_ms DESC);
`)

const cols = db.prepare(`PRAGMA table_info(ads)`).all().map((c) => c.name)
if (!cols.includes('public_path')) {
  db.exec(`ALTER TABLE ads ADD COLUMN public_path TEXT NOT NULL DEFAULT ''`)
  db.exec(`UPDATE ads SET public_path = storage_path WHERE public_path = ''`)
}

const app = express()
app.use(cors())
app.use(express.json({ limit: '2mb' }))

app.use('/uploads', express.static(UPLOADS_DIR, { fallthrough: false }))

function safeDirName(input) {
  const raw = String(input || '').trim()
  const cleaned = raw
    .replaceAll(/[^a-zA-Z0-9._-]+/g, '-')
    .replaceAll(/-+/g, '-')
    .replaceAll(/^\.+/g, '')
    .replaceAll(/\.+$/g, '')
    .slice(0, 80)
  return cleaned || 'default'
}

const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const directoryName = safeDirName(req.body?.directoryName || 'default')
    const dir = path.join(UPLOADS_DIR, directoryName)
    fs.mkdirSync(dir, { recursive: true })
    cb(null, dir)
  },
  filename: (_req, file, cb) => {
    const id = crypto.randomUUID()
    const ext = path.extname(file.originalname || '').toLowerCase() || '.mp4'
    cb(null, `${id}${ext === '.mp4' ? '.mp4' : '.mp4'}`)
  },
})

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok =
      file.mimetype === 'video/mp4' || (file.originalname || '').toLowerCase().endsWith('.mp4')
    cb(ok ? null : new Error('Only MP4 files are allowed'), ok)
  },
})

app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})

app.post('/api/ads', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file is required' })

  const id = path.parse(req.file.filename).name
  const directoryName = safeDirName(req.body?.directoryName || 'default')
  const title = String(req.body?.title || '').trim() || req.file.originalname


  const storagePath = req.file.path
  const publicPath = path.relative(UPLOADS_DIR, req.file.path).split(path.sep).join('/')
  const createdAtMs = Date.now()

  const row = {
    id,
    directory_name: directoryName,
    title,
    original_filename: req.file.originalname,
    storage_path: storagePath,
    public_path: publicPath,
    mime_type: req.file.mimetype || 'video/mp4',
    size_bytes: req.file.size,
    created_at_ms: createdAtMs,
  }

  db.prepare(
    `INSERT INTO ads
      (id, directory_name, title, original_filename, storage_path, public_path, mime_type, size_bytes, created_at_ms)
     VALUES
      (@id, @directory_name, @title, @original_filename, @storage_path, @public_path, @mime_type, @size_bytes, @created_at_ms)`,
  ).run(row)

  res.status(201).json({
    ...row,
    url: `/uploads/${row.public_path}`,
  })
})

app.get('/api/ads', (_req, res) => {
  const rows = db
    .prepare(
      `SELECT id, directory_name, title, original_filename, storage_path, public_path, mime_type, size_bytes, created_at_ms
       FROM ads
       ORDER BY created_at_ms DESC`,
    )
    .all()
    .map((r) => ({ ...r, url: `/uploads/${r.public_path}` }))
  res.json(rows)
})

app.get('/api/ads/:id', (req, res) => {
  const id = String(req.params.id || '')
  const row = db
    .prepare(
      `SELECT id, directory_name, title, original_filename, storage_path, public_path, mime_type, size_bytes, created_at_ms
       FROM ads
       WHERE id = ?`,
    )
    .get(id)
  if (!row) return res.status(404).json({ error: 'not found' })
  res.json({ ...row, url: `/uploads/${row.public_path}` })
})

app.delete('/api/ads/:id', (req, res) => {
  const id = String(req.params.id || '')
  const row = db
    .prepare(
      `SELECT id, storage_path, public_path
       FROM ads
       WHERE id = ?`,
    )
    .get(id)
  if (!row) return res.status(404).json({ error: 'not found' })

  const storagePath = String(row.storage_path || '')
  const resolved = path.resolve(storagePath)
  const uploadsRoot = path.resolve(UPLOADS_DIR) + path.sep
  if (!resolved.startsWith(uploadsRoot)) {
    return res.status(400).json({ error: 'Refusing to delete file outside uploads dir' })
  }

  try {
    if (fs.existsSync(resolved)) fs.unlinkSync(resolved)
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : 'Failed to delete file' })
  }

  db.prepare(`DELETE FROM ads WHERE id = ?`).run(id)
  res.json({ ok: true })
})

app.use((err, _req, res, _next) => {
  const msg = err?.message || 'Server error'
  res.status(400).json({ error: msg })
})

app.listen(PORT, () => {
  console.log(`API listening on http://127.0.0.1:${PORT}`)
})

