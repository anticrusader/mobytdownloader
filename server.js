const express = require('express');
const compression = require('compression');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs').promises;
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
    },
  },
}));

app.use(compression());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// Create temp directory for downloads
const TEMP_DIR = '/tmp/downloads';
const ensureTempDir = async () => {
  try {
    await fs.mkdir(TEMP_DIR, { recursive: true });
  } catch (error) {
    console.log('Temp directory ready');
  }
};

// Download tracking
const downloadStatus = new Map();

// Install yt-dlp on startup
const installYtDlp = async () => {
  return new Promise((resolve, reject) => {
    console.log('🔧 Installing yt-dlp...');
    const install = spawn('pip', ['install', 'yt-dlp'], { stdio: 'inherit' });
    
    install.on('close', (code) => {
      if (code === 0) {
        console.log('✅ yt-dlp installed successfully');
        resolve();
      } else {
        console.error('❌ yt-dlp installation failed');
        reject(new Error('Installation failed'));
      }
    });
  });
};

// Get video info
const getVideoInfo = (url) => {
  return new Promise((resolve, reject) => {
    const ytdlp = spawn('yt-dlp', ['--dump-json', '--no-download', url]);
    let data = '';
    
    ytdlp.stdout.on('data', (chunk) => {
      data += chunk;
    });
    
    ytdlp.stderr.on('data', (chunk) => {
      console.error('yt-dlp error:', chunk.toString());
    });
    
    ytdlp.on('close', (code) => {
      if (code === 0) {
        try {
          const info = JSON.parse(data);
          resolve({
            title: info.title,
            duration: info.duration,
            thumbnail: info.thumbnail,
            uploader: info.uploader,
            view_count: info.view_count,
            upload_date: info.upload_date,
            filesize: info.filesize
          });
        } catch (err) {
          reject(new Error('Failed to parse video info'));
        }
      } else {
        reject(new Error('Failed to get video info'));
      }
    });
  });
};

// Download video
const downloadVideo = (url, quality, downloadId) => {
  return new Promise((resolve, reject) => {
    const filename = `${downloadId}.%(ext)s`;
    const outputPath = path.join(TEMP_DIR, filename);
    
    let args = ['-o', outputPath];
    
    // Quality settings
    if (quality === 'audio') {
      args.push('--extract-audio', '--audio-format', 'mp3');
    } else if (quality !== 'best') {
      args.push('-f', quality);
    }
    
    // Add progress hooks
    args.push('--newline');
    args.push(url);
    
    const ytdlp = spawn('yt-dlp', args);
    
    ytdlp.stdout.on('data', (data) => {
      const output = data.toString();
      
      // Parse progress
      if (output.includes('%')) {
        const progress = output.match(/(\d+(?:\.\d+)?)%/);
        if (progress) {
          downloadStatus.set(downloadId, {
            status: 'downloading',
            progress: parseFloat(progress[1])
          });
        }
      }
    });
    
    ytdlp.stderr.on('data', (data) => {
      console.error('Download error:', data.toString());
    });
    
    ytdlp.on('close', (code) => {
      if (code === 0) {
        downloadStatus.set(downloadId, { status: 'completed' });
        resolve(downloadId);
      } else {
        downloadStatus.set(downloadId, { status: 'error', error: 'Download failed' });
        reject(new Error('Download failed'));
      }
    });
  });
};

// API Routes

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Get video info
app.post('/api/info', async (req, res) => {
  try {
    const { url } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }
    
    const info = await getVideoInfo(url);
    res.json({ success: true, ...info });
    
  } catch (error) {
    res.status(400).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Start download
app.post('/api/download', async (req, res) => {
  try {
    const { url, quality } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }
    
    const downloadId = uuidv4();
    downloadStatus.set(downloadId, { status: 'starting' });
    
    // Start download in background
    downloadVideo(url, quality, downloadId).catch(err => {
      console.error('Download error:', err);
      downloadStatus.set(downloadId, { status: 'error', error: err.message });
    });
    
    res.json({ 
      success: true, 
      downloadId,
      message: 'Download started'
    });
    
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Check download status
app.get('/api/status/:downloadId', (req, res) => {
  const { downloadId } = req.params;
  const status = downloadStatus.get(downloadId);
  
  if (!status) {
    return res.status(404).json({ error: 'Download not found' });
  }
  
  res.json(status);
});

// Download file
app.get('/api/file/:downloadId', async (req, res) => {
  try {
    const { downloadId } = req.params;
    const status = downloadStatus.get(downloadId);
    
    if (!status || status.status !== 'completed') {
      return res.status(404).json({ error: 'File not ready' });
    }
    
    // Find the downloaded file
    const files = await fs.readdir(TEMP_DIR);
    const downloadedFile = files.find(file => file.startsWith(downloadId));
    
    if (!downloadedFile) {
      return res.status(404).json({ error: 'File not found' });
    }
    
    const filePath = path.join(TEMP_DIR, downloadedFile);
    const stats = await fs.stat(filePath);
    
    // Set headers for download
    res.setHeader('Content-Disposition', `attachment; filename="${downloadedFile}"`);
    res.setHeader('Content-Length', stats.size);
    res.setHeader('Content-Type', 'application/octet-stream');
    
    // Stream the file
    const fileStream = require('fs').createReadStream(filePath);
    fileStream.pipe(res);
    
    // Cleanup after download
    fileStream.on('end', async () => {
      try {
        await fs.unlink(filePath);
        downloadStatus.delete(downloadId);
        console.log(`Cleaned up: ${downloadedFile}`);
      } catch (err) {
        console.error('Cleanup error:', err);
      }
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Serve main app
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Cleanup old downloads every hour
setInterval(async () => {
  try {
    const files = await fs.readdir(TEMP_DIR);
    const now = Date.now();
    
    for (const file of files) {
      const filePath = path.join(TEMP_DIR, file);
      const stats = await fs.stat(filePath);
      
      // Delete files older than 1 hour
      if (now - stats.mtime.getTime() > 60 * 60 * 1000) {
        await fs.unlink(filePath);
        console.log(`Auto-cleaned: ${file}`);
      }
    }
  } catch (error) {
    console.error('Auto-cleanup error:', error);
  }
}, 60 * 60 * 1000);

// Initialize server
const startServer = async () => {
  try {
    await ensureTempDir();
    await installYtDlp();
    
    app.listen(port, () => {
      console.log(`🚀 YouTube Direct Downloader running on port ${port}`);
      console.log(`📱 Ready for direct downloads!`);
    });
  } catch (error) {
    console.error('Server startup failed:', error);
    
    // Start server anyway for basic functionality
    app.listen(port, () => {
      console.log(`⚠️  Server running with limited functionality on port ${port}`);
    });
  }
};

startServer();

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('👋 Shutting down gracefully...');
  process.exit(0);
});
