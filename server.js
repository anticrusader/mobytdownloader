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

// Global state variables
const downloadStatus = new Map();
let ytDlpAvailable = false;
let ytDlpPath = 'yt-dlp';
let directDownloadAttempts = 0;
let successfulDownloads = 0;
let serverReady = false;

// Enhanced User Agents for rotation
const userAgents = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
];

let currentUserAgentIndex = 0;

const getRandomUserAgent = () => {
  const agent = userAgents[currentUserAgentIndex];
  currentUserAgentIndex = (currentUserAgentIndex + 1) % userAgents.length;
  return agent;
};

// Create realistic session cookies
const createSessionCookies = () => {
  const sessionId = Math.random().toString(36).substring(2, 15);
  const timestamp = Date.now();
  
  return [
    `VISITOR_INFO1_LIVE=${sessionId}_${timestamp}`,
    `YSC=${sessionId}`,
    `PREF=f1=50000000&f6=40000000&hl=en`
  ].join('; ');
};

// Extract video ID from URL
const extractVideoId = (url) => {
  const regex = /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/;
  const match = url.match(regex);
  return match ? match[1] : null;
};

// Quick yt-dlp check (non-blocking)
const quickYtDlpCheck = () => {
  console.log('🔧 Quick yt-dlp check...');
  
  exec('yt-dlp --version', { timeout: 3000 }, (error, stdout, stderr) => {
    if (!error) {
      ytDlpAvailable = true;
      ytDlpPath = 'yt-dlp';
      console.log('✅ yt-dlp available');
    } else {
      exec('/tmp/yt-dlp --version', { timeout: 3000 }, (error2, stdout2, stderr2) => {
        if (!error2) {
          ytDlpAvailable = true;
          ytDlpPath = '/tmp/yt-dlp';
          console.log('✅ yt-dlp available at /tmp/yt-dlp');
        } else {
          console.log('⚠️  yt-dlp not immediately available - will install in background');
          installYtDlpBackground();
        }
      });
    }
  });
};

// Background yt-dlp installation
const installYtDlpBackground = () => {
  console.log('🔧 Installing yt-dlp in background...');
  
  exec('curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /tmp/yt-dlp && chmod +x /tmp/yt-dlp', 
    { timeout: 60000 }, (error, stdout, stderr) => {
    if (!error) {
      ytDlpAvailable = true;
      ytDlpPath = '/tmp/yt-dlp';
      console.log('✅ yt-dlp installed successfully in background');
    } else {
      console.log('❌ Background yt-dlp installation failed');
    }
  });
};

// Enhanced video info with timeout
const getVideoInfo = async (url) => {
  if (!ytDlpAvailable) {
    throw new Error('yt-dlp not available');
  }

  console.log(`🔍 Getting video info: ${url}`);
  
  return new Promise((resolve, reject) => {
    const args = [
      '--dump-json', '--no-download', '--no-warnings', '--ignore-errors',
      '--user-agent', getRandomUserAgent(),
      '--add-header', 'Accept-Language:en-US,en;q=0.9',
      '--add-header', `Cookie: ${createSessionCookies()}`,
      '--extractor-args', 'youtube:player_client=web',
      url
    ];
    
    const ytdlp = spawn(ytDlpPath, args);
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
        try {
          const info = JSON.parse(data.trim());
          resolve({
            title: info.title || 'Unknown Title',
            duration: info.duration || 0,
            uploader: info.uploader || 'Unknown Uploader',
            view_count: info.view_count || 0,
            thumbnail: info.thumbnail || '',
            webpage_url: info.webpage_url || url
          });
        } catch (parseError) {
          reject(new Error('Failed to parse video info'));
        }
      } else {
        reject(new Error('Failed to get video info'));
      }
    });

    // Quick timeout for video info
    setTimeout(() => {
      ytdlp.kill();
      reject(new Error('Video info timeout'));
    }, 15000);
  });
};

// Enhanced download function
const downloadVideo = async (url, quality, downloadId) => {
  if (!ytDlpAvailable) {
    throw new Error('yt-dlp not available');
  }

  directDownloadAttempts++;
  console.log(`⬇️ Starting download: ${downloadId}`);
  
  const filename = `${downloadId}.%(ext)s`;
  const outputPath = `/tmp/downloads/${filename}`;
  
  // Ensure downloads directory exists
  try {
    await fs.mkdir('/tmp/downloads', { recursive: true });
  } catch (e) {
    // Directory exists
  }
  
  return new Promise((resolve, reject) => {
    const args = [
      '-o', outputPath, '--newline', '--no-warnings', '--ignore-errors',
      '--user-agent', getRandomUserAgent(),
      '--add-header', 'Accept-Language:en-US,en;q=0.9',
      '--add-header', `Cookie: ${createSessionCookies()}`,
      '--sleep-interval', '1', '--max-sleep-interval', '3',
      '--retries', '3', '--fragment-retries', '3',
      '--extractor-args', 'youtube:player_client=web'
    ];
    
    if (quality === 'audio') {
      args.push('--extract-audio', '--audio-format', 'mp3');
    } else if (quality !== 'best') {
      args.push('-f', quality);
    }
    
    args.push(url);
    
    const ytdlp = spawn(ytDlpPath, args);
    
    ytdlp.stdout.on('data', (data) => {
      const output = data.toString();
      const progressMatch = output.match(/(\d+(?:\.\d+)?)%/);
      if (progressMatch) {
        const progress = parseFloat(progressMatch[1]);
        downloadStatus.set(downloadId, {
          status: 'downloading',
          progress: progress
        });
      }
    });
    
    ytdlp.stderr.on('data', (data) => {
      console.error('Download stderr:', data.toString());
    });
    
    ytdlp.on('close', (code) => {
      if (code === 0) {
        successfulDownloads++;
        downloadStatus.set(downloadId, { status: 'completed' });
        console.log(`✅ Download completed: ${downloadId}`);
        resolve(downloadId);
      } else {
        downloadStatus.set(downloadId, { 
          status: 'error', 
          error: `Download failed with code ${code}`
        });
        reject(new Error(`Download failed with code ${code}`));
      }
    });
    
    // Download timeout
    setTimeout(() => {
      ytdlp.kill();
      downloadStatus.set(downloadId, { 
        status: 'error', 
        error: 'Download timed out'
      });
      reject(new Error('Download timeout'));
    }, 300000); // 5 minutes
  });
};

// Immediate health check endpoint (most important for Render)
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK',
    timestamp: new Date().toISOString(),
    server_ready: serverReady,
    ytdlp_available: ytDlpAvailable
  });
});

// API health endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    ytdlp_available: ytDlpAvailable,
    ytdlp_path: ytDlpPath,
    server_ready: serverReady,
    download_stats: {
      attempts: directDownloadAttempts,
      successful: successfulDownloads,
      success_rate: directDownloadAttempts > 0 ? (successfulDownloads / directDownloadAttempts * 100).toFixed(1) + '%' : 'N/A'
    }
  });
});

app.get('/api/capabilities', (req, res) => {
  res.json({
    ytdlp_available: ytDlpAvailable,
    ytdlp_path: ytDlpPath,
    server_ready: serverReady,
    features: {
      video_info: ytDlpAvailable,
      video_download: ytDlpAvailable,
      command_generation: true,
      multi_strategy: true
    },
    download_stats: {
      attempts: directDownloadAttempts,
      successful: successfulDownloads,
      success_rate: directDownloadAttempts > 0 ? (successfulDownloads / directDownloadAttempts * 100).toFixed(1) + '%' : 'N/A'
    }
  });
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
      const basicInfo = {
        title: `YouTube Video (${extractVideoId(url) || 'Unknown'})`,
        duration: 0,
        uploader: 'YouTube',
        view_count: 0,
        thumbnail: `https://img.youtube.com/vi/${extractVideoId(url)}/maxresdefault.jpg`,
        webpage_url: url,
        fallback: true
      };
      
      return res.json({ 
        success: true, 
        ...basicInfo,
        message: 'yt-dlp not ready yet, using basic info'
      });
    }
    
    try {
      const info = await getVideoInfo(url);
      res.json({ 
        success: true, 
        ...info,
        message: 'Video info retrieved successfully'
      });
    } catch (error) {
      const basicInfo = {
        title: `YouTube Video (${extractVideoId(url) || 'Unknown'})`,
        duration: 0,
        uploader: 'YouTube',
        view_count: 0,
        thumbnail: `https://img.youtube.com/vi/${extractVideoId(url)}/maxresdefault.jpg`,
        webpage_url: url,
        fallback: true
      };
      
      res.json({ 
        success: true, 
        ...basicInfo,
        message: 'Using basic info due to API issues',
        error: error.message
      });
    }
    
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
      return res.status(400).json({ 
        success: false, 
        error: 'URL is required' 
      });
    }
    
    if (!ytDlpAvailable) {
      return res.status(503).json({ 
        success: false, 
        error: 'yt-dlp not ready yet, please try again in a moment',
        fallback: true
      });
    }
    
    const downloadId = uuidv4();
    downloadStatus.set(downloadId, { status: 'starting' });
    
    // Start download
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
      message: 'Download started with enhanced anti-detection'
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
    
    const files = await fs.readdir('/tmp/downloads');
    const downloadedFile = files.find(file => file.startsWith(downloadId));
    
    if (!downloadedFile) {
      return res.status(404).json({ 
        error: 'File not found' 
      });
    }
    
    const filePath = `/tmp/downloads/${downloadedFile}`;
    const stats = await fs.stat(filePath);
    
    const cleanFilename = downloadedFile.replace(downloadId + '.', '');
    res.setHeader('Content-Disposition', `attachment; filename="${cleanFilename}"`);
    res.setHeader('Content-Length', stats.size);
    res.setHeader('Content-Type', 'application/octet-stream');
    
    const fileStream = require('fs').createReadStream(filePath);
    fileStream.pipe(res);
    
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

// Command generation
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
      message: 'Command generated successfully'
    });
    
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Serve main app
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server immediately (critical for Render health checks)
const server = app.listen(port, () => {
  console.log(`🚀 Server LIVE on port ${port}`);
  console.log(`🌍 Health check ready at /health`);
  serverReady = true;
  
  // Start background initialization
  setTimeout(() => {
    console.log('🔧 Starting background initialization...');
    quickYtDlpCheck();
  }, 1000);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('👋 Shutting down gracefully...');
  server.close(() => {
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('👋 Shutting down gracefully...');
  server.close(() => {
    process.exit(0);
  });
});
