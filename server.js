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
let ytDlpPath = 'yt-dlp';

// Quick installation attempt with timeout
const tryInstallYtDlp = async () => {
  console.log('🔧 Quick yt-dlp installation check...');
  
  const methods = [
    {
      name: 'existing yt-dlp',
      command: 'yt-dlp --version',
      timeout: 5000,
      path: 'yt-dlp'
    },
    {
      name: 'existing /tmp/yt-dlp',
      command: '/tmp/yt-dlp --version',
      timeout: 5000,
      path: '/tmp/yt-dlp'
    },
    {
      name: 'pip user install',
      command: 'pip install --user yt-dlp && yt-dlp --version',
      timeout: 30000,
      path: 'yt-dlp'
    },
    {
      name: 'direct download',
      command: 'curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /tmp/yt-dlp && chmod +x /tmp/yt-dlp && /tmp/yt-dlp --version',
      timeout: 20000,
      path: '/tmp/yt-dlp'
    }
  ];

  for (const method of methods) {
    try {
      console.log(`🔧 Trying: ${method.name}...`);
      
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          console.log(`⏰ ${method.name} timed out`);
          reject(new Error('Timeout'));
        }, method.timeout);

        exec(method.command, (error, stdout, stderr) => {
          clearTimeout(timeout);
          if (error) {
            console.log(`❌ ${method.name} failed:`, error.message);
            reject(error);
          } else {
            console.log(`✅ ${method.name} succeeded`);
            ytDlpPath = method.path;
            resolve(stdout);
          }
        });
      });

      ytDlpAvailable = true;
      console.log(`✅ yt-dlp is available at: ${ytDlpPath}`);
      return;
      
    } catch (error) {
      console.log(`❌ ${method.name} failed, trying next...`);
      continue;
    }
  }
  
  console.log('⚠️  yt-dlp not available, starting in command generation mode');
  ytDlpAvailable = false;
};

// Safe JSON parse
const safeJsonParse = (data) => {
  try {
    return JSON.parse(data);
  } catch (error) {
    console.error('JSON parse error:', error);
    return null;
  }
};

// Get video info with robust error handling
const getVideoInfo = (url) => {
  return new Promise((resolve, reject) => {
    if (!ytDlpAvailable) {
      reject(new Error('yt-dlp not available'));
      return;
    }

    console.log(`🔍 Getting video info for: ${url}`);
    
    const ytdlp = spawn(ytDlpPath, [
      '--dump-json', 
      '--no-download',
      '--no-warnings',
      '--ignore-errors',
      url
    ]);
    
    let data = '';
    let errorData = '';
    
    ytdlp.stdout.on('data', (chunk) => {
      data += chunk;
    });
    
    ytdlp.stderr.on('data', (chunk) => {
      errorData += chunk;
    });
    
    ytdlp.on('close', (code) => {
      if (code === 0 && data.trim()) {
        const info = safeJsonParse(data.trim());
        if (info) {
          resolve({
            title: info.title || 'Unknown Title',
            duration: info.duration || 0,
            uploader: info.uploader || 'Unknown Uploader',
            view_count: info.view_count || 0,
            thumbnail: info.thumbnail || '',
            webpage_url: info.webpage_url || url
          });
        } else {
          reject(new Error('Invalid video data received'));
        }
      } else {
        console.error('yt-dlp error:', errorData);
        reject(new Error('Failed to get video info: ' + (errorData || 'Unknown error')));
      }
    });

    // Timeout after 30 seconds
    setTimeout(() => {
      ytdlp.kill();
      reject(new Error('Video info request timed out'));
    }, 30000);
  });
};

// Download video with progress tracking
const downloadVideo = (url, quality, downloadId) => {
  return new Promise((resolve, reject) => {
    if (!ytDlpAvailable) {
      reject(new Error('yt-dlp not available'));
      return;
    }

    console.log(`⬇️ Starting download: ${downloadId}`);
    
    const filename = `${downloadId}.%(ext)s`;
    const outputPath = path.join(TEMP_DIR, filename);
    
    let args = [
      '-o', outputPath,
      '--newline',
      '--no-warnings'
    ];
    
    // Quality settings
    if (quality === 'audio') {
      args.push('--extract-audio', '--audio-format', 'mp3');
    } else if (quality !== 'best') {
      args.push('-f', quality);
    }
    
    args.push(url);
    
    const ytdlp = spawn(ytDlpPath, args);
    
    ytdlp.stdout.on('data', (data) => {
      const output = data.toString();
      console.log('yt-dlp output:', output);
      
      // Parse progress
      const progressMatch = output.match(/(\d+(?:\.\d+)?)%/);
      if (progressMatch) {
        const progress = parseFloat(progressMatch[1]);
        downloadStatus.set(downloadId, {
          status: 'downloading',
          progress: progress
        });
        console.log(`📊 Progress: ${progress}%`);
      }
    });
    
    ytdlp.stderr.on('data', (data) => {
      console.error('Download stderr:', data.toString());
    });
    
    ytdlp.on('close', (code) => {
      if (code === 0) {
        downloadStatus.set(downloadId, { status: 'completed' });
        console.log(`✅ Download completed: ${downloadId}`);
        resolve(downloadId);
      } else {
        const errorMsg = `Download failed with code ${code}`;
        downloadStatus.set(downloadId, { status: 'error', error: errorMsg });
        console.error(`❌ ${errorMsg}`);
        reject(new Error(errorMsg));
      }
    });
  });
};

// API Routes
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    ytdlp_available: ytDlpAvailable,
    ytdlp_path: ytDlpPath
  });
});

app.get('/api/capabilities', (req, res) => {
  res.json({
    ytdlp_available: ytDlpAvailable,
    ytdlp_path: ytDlpPath,
    features: {
      video_info: ytDlpAvailable,
      video_download: ytDlpAvailable,
      command_generation: true
    }
  });
});

// Generate command (always works)
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
      instructions: 'Install yt-dlp locally and run this command in your terminal'
    });
    
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Get video info
app.post('/api/info', async (req, res) => {
  try {
    const { url } = req.body;
    
    if (!url) {
      return res.status(400).json({ 
        success: false, 
        error: 'URL is required' 
      });
    }
    
    if (!ytDlpAvailable) {
      return res.status(200).json({ 
        success: true,
        title: 'Video URL Ready',
        uploader: 'Ready for download',
        duration: 0,
        fallback: true,
        message: 'Video info not available in command generation mode'
      });
    }
    
    const info = await getVideoInfo(url);
    res.json({ 
      success: true, 
      ...info 
    });
    
  } catch (error) {
    console.error('Video info error:', error);
    res.status(200).json({ 
      success: true,
      title: 'Video URL Detected',
      uploader: 'Ready for processing',
      duration: 0,
      fallback: true,
      error: error.message
    });
  }
});

// Start download
app.post('/api/download', async (req, res) => {
  try {
    const { url, quality } = req.body;
    
    if (!url) {
      return res.status(400).json({ 
        success: false, 
        error: 'URL is required' 
      });
    }
    
    if (!ytDlpAvailable) {
      return res.status(503).json({ 
        success: false, 
        error: 'Server-side downloading not available. Use command generation instead.',
        fallback: true
      });
    }
    
    const downloadId = uuidv4();
    downloadStatus.set(downloadId, { status: 'starting' });
    
    // Start download in background
    downloadVideo(url, quality, downloadId).catch(err => {
      console.error('Download error:', err);
      downloadStatus.set(downloadId, { 
        status: 'error', 
        error: err.message 
      });
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
    return res.status(404).json({ 
      error: 'Download not found' 
    });
  }
  
  res.json(status);
});

// Download file
app.get('/api/file/:downloadId', async (req, res) => {
  try {
    const { downloadId } = req.params;
    const status = downloadStatus.get(downloadId);
    
    if (!status || status.status !== 'completed') {
      return res.status(404).json({ 
        error: 'File not ready' 
      });
    }
    
    // Find the downloaded file
    const files = await fs.readdir(TEMP_DIR);
    const downloadedFile = files.find(file => file.startsWith(downloadId));
    
    if (!downloadedFile) {
      return res.status(404).json({ 
        error: 'File not found' 
      });
    }
    
    const filePath = path.join(TEMP_DIR, downloadedFile);
    const stats = await fs.stat(filePath);
    
    // Set headers for download
    const cleanFilename = downloadedFile.replace(downloadId + '.', '');
    res.setHeader('Content-Disposition', `attachment; filename="${cleanFilename}"`);
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
        console.log(`🧹 Cleaned up: ${downloadedFile}`);
      } catch (err) {
        console.error('Cleanup error:', err);
      }
    });
    
  } catch (error) {
    res.status(500).json({ 
      error: error.message 
    });
  }
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
        console.log(`🧹 Auto-cleaned: ${file}`);
      }
    }
  } catch (error) {
    console.error('Auto-cleanup error:', error);
  }
}, 60 * 60 * 1000);

// Serve main app
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Initialize server with quick startup
const startServer = async () => {
  console.log('🚀 Starting YouTube Direct Downloader...');
  
  // Start server immediately
  const server = app.listen(port, () => {
    console.log(`🌟 Server running on port ${port}`);
    console.log(`🌍 Server is LIVE and ready for requests!`);
  });
  
  // Try to install yt-dlp in background
  setTimeout(async () => {
    try {
      await ensureTempDir();
      await tryInstallYtDlp();
      console.log(`📱 yt-dlp status: ${ytDlpAvailable ? 'Available' : 'Command generation mode'}`);
    } catch (error) {
      console.log('⚠️  Background setup completed with limitations');
      ytDlpAvailable = false;
    }
  }, 1000);
  
  return server;
};

// Start the server
startServer().catch(error => {
  console.error('❌ Server startup failed:', error);
  app.listen(port, () => {
    console.log(`🆘 Emergency server running on port ${port}`);
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('👋 Shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('👋 Shutting down gracefully...');
  process.exit(0);
});
