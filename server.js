const express = require('express');
const compression = require('compression');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs').promises;
const { spawn, exec } = require('child_process');
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
    console.log('📁 Temp directory ready');
  } catch (error) {
    console.log('📁 Temp directory already exists');
  }
};

// Download tracking
const downloadStatus = new Map();
let ytDlpAvailable = false;

// Multiple installation methods for yt-dlp
const installYtDlp = async () => {
  const methods = [
    // Method 1: Try pipx (recommended for externally managed environments)
    () => new Promise((resolve, reject) => {
      console.log('🔧 Trying pipx install...');
      const install = spawn('pipx', ['install', 'yt-dlp'], { stdio: 'inherit' });
      install.on('close', (code) => code === 0 ? resolve() : reject());
    }),
    
    // Method 2: Try pip with --user flag
    () => new Promise((resolve, reject) => {
      console.log('🔧 Trying pip install --user...');
      const install = spawn('pip', ['install', '--user', 'yt-dlp'], { stdio: 'inherit' });
      install.on('close', (code) => code === 0 ? resolve() : reject());
    }),
    
    // Method 3: Try pip3 with --user flag
    () => new Promise((resolve, reject) => {
      console.log('🔧 Trying pip3 install --user...');
      const install = spawn('pip3', ['install', '--user', 'yt-dlp'], { stdio: 'inherit' });
      install.on('close', (code) => code === 0 ? resolve() : reject());
    }),
    
    // Method 4: Try with virtual environment
    () => new Promise((resolve, reject) => {
      console.log('🔧 Trying virtual environment...');
      exec('python3 -m venv /tmp/venv && /tmp/venv/bin/pip install yt-dlp', (error) => {
        if (error) reject(error);
        else resolve();
      });
    }),
    
    // Method 5: Try apt install (for Debian/Ubuntu systems)
    () => new Promise((resolve, reject) => {
      console.log('🔧 Trying apt install...');
      const install = spawn('apt', ['install', '-y', 'yt-dlp'], { stdio: 'inherit' });
      install.on('close', (code) => code === 0 ? resolve() : reject());
    }),
    
    // Method 6: Download binary directly
    () => new Promise((resolve, reject) => {
      console.log('🔧 Downloading yt-dlp binary...');
      exec('curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /tmp/yt-dlp && chmod +x /tmp/yt-dlp', (error) => {
        if (error) reject(error);
        else resolve();
      });
    })
  ];

  for (const method of methods) {
    try {
      await method();
      console.log('✅ yt-dlp installed successfully');
      ytDlpAvailable = true;
      return;
    } catch (error) {
      console.log('❌ Installation method failed, trying next...');
    }
  }
  
  console.log('⚠️  Could not install yt-dlp, server will run in limited mode');
  ytDlpAvailable = false;
};

// Check if yt-dlp is available and get the correct command
const getYtDlpCommand = () => {
  const possiblePaths = [
    'yt-dlp',
    '/tmp/yt-dlp',
    '/tmp/venv/bin/yt-dlp',
    '~/.local/bin/yt-dlp',
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp'
  ];
  
  for (const path of possiblePaths) {
    try {
      // Test if command exists
      const test = spawn(path, ['--version'], { stdio: 'pipe' });
      test.on('close', (code) => {
        if (code === 0) {
          console.log(`✅ Found yt-dlp at: ${path}`);
          return path;
        }
      });
    } catch (error) {
      continue;
    }
  }
  
  return 'yt-dlp'; // Fallback to default
};

// Get video info
const getVideoInfo = (url) => {
  return new Promise((resolve, reject) => {
    if (!ytDlpAvailable) {
      reject(new Error('yt-dlp not available on this server'));
      return;
    }
    
    const ytdlpCmd = getYtDlpCommand();
    const ytdlp = spawn(ytdlpCmd, ['--dump-json', '--no-download', url]);
    let data = '';
    
    ytdlp.stdout.on('data', (chunk) => {
      data += chunk;
    });
    
    ytdlp.stderr.on('data', (chunk) => {
      console.error('yt-dlp stderr:', chunk.toString());
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
    if (!ytDlpAvailable) {
      reject(new Error('yt-dlp not available on this server'));
      return;
    }
    
    const filename = `${downloadId}.%(ext)s`;
    const outputPath = path.join(TEMP_DIR, filename);
    const ytdlpCmd = getYtDlpCommand();
    
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
    
    const ytdlp = spawn(ytdlpCmd, args);
    
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
    uptime: process.uptime(),
    ytdlp_available: ytDlpAvailable
  });
});

// Check server capabilities
app.get('/api/capabilities', (req, res) => {
  res.json({
    ytdlp_available: ytDlpAvailable,
    features: {
      video_info: ytDlpAvailable,
      video_download: ytDlpAvailable,
      command_generation: true
    }
  });
});

// Get video info
app.post('/api/info', async (req, res) => {
  try {
    const { url } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }
    
    if (!ytDlpAvailable) {
      return res.status(503).json({ 
        success: false, 
        error: 'Server-side downloading not available. Please use command generation instead.',
        fallback: true
      });
    }
    
    const info = await getVideoInfo(url);
    res.json({ success: true, ...info });
    
  } catch (error) {
    res.status(400).json({ 
      success: false, 
      error: error.message,
      fallback: !ytDlpAvailable
    });
  }
});

// Generate command (fallback when yt-dlp not available)
app.post('/api/command', (req, res) => {
  try {
    const { url, quality } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }
    
    let command = 'yt-dlp ';
    
    if (quality === 'audio') {
      command += '--extract-audio --audio-format mp3 ';
    } else if (quality !== 'best') {
      command += `-f "${quality}" `;
    }
    
    command += '--output "%(title)s.%(ext)s" ';
    command += `"${url}"`;
    
    res.json({
      success: true,
      command: command,
      message: 'Command generated successfully',
      instructions: 'Copy this command and run it in your terminal with yt-dlp installed'
    });
    
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Start download (only if yt-dlp available)
app.post('/api/download', async (req, res) => {
  try {
    const { url, quality } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }
    
    if (!ytDlpAvailable) {
      return res.status(503).json({ 
        success: false, 
        error: 'Server-side downloading not available on this deployment.',
        suggestion: 'Use the command generation feature instead.',
        fallback: true
      });
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
      console.log(`📱 yt-dlp available: ${ytDlpAvailable ? 'Yes' : 'No (fallback mode)'}`);
      if (!ytDlpAvailable) {
        console.log(`💡 Server running in command generation mode`);
      }
    });
  } catch (error) {
    console.error('Server startup error:', error);
    
    // Start server anyway for basic functionality
    app.listen(port, () => {
      console.log(`⚠️  Server running in fallback mode on port ${port}`);
      console.log(`💡 Command generation available`);
    });
  }
};

startServer();

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('👋 Shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('👋 Shutting down gracefully...');
  process.exit(0);
});
