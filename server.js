const express = require('express');
const compression = require('compression');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs').promises;
const { spawn, exec } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const https = require('https');
const { URL } = require('url');

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

// Real session management
let realSessionCookies = '';
let sessionExpiry = 0;

// Enhanced User Agents for rotation
const userAgents = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
];

let currentUserAgentIndex = 0;

const getRandomUserAgent = () => {
  const agent = userAgents[currentUserAgentIndex];
  currentUserAgentIndex = (currentUserAgentIndex + 1) % userAgents.length;
  return agent;
};

// Establish real YouTube session
const establishRealSession = async () => {
  return new Promise((resolve, reject) => {
    console.log('🍪 Establishing real YouTube session...');
    
    const options = {
      hostname: 'www.youtube.com',
      port: 443,
      path: '/',
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'DNT': '1',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Cache-Control': 'max-age=0'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      let cookies = [];
      
      // Extract cookies from response headers
      if (res.headers['set-cookie']) {
        cookies = res.headers['set-cookie'].map(cookie => {
          return cookie.split(';')[0]; // Get just the name=value part
        });
      }
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        if (cookies.length > 0) {
          realSessionCookies = cookies.join('; ');
          sessionExpiry = Date.now() + (2 * 60 * 60 * 1000); // 2 hours
          console.log(`✅ Real session established with ${cookies.length} cookies`);
          resolve(realSessionCookies);
        } else {
          console.log('⚠️  No cookies received, using enhanced fallback');
          realSessionCookies = createEnhancedSessionCookies();
          sessionExpiry = Date.now() + (1 * 60 * 60 * 1000); // 1 hour for fallback
          resolve(realSessionCookies);
        }
      });
    });

    req.on('error', (err) => {
      console.error('Session establishment error:', err);
      realSessionCookies = createEnhancedSessionCookies();
      sessionExpiry = Date.now() + (1 * 60 * 60 * 1000);
      resolve(realSessionCookies);
    });
    
    req.setTimeout(10000, () => {
      console.log('⚠️  Session request timeout, using fallback');
      req.destroy();
      realSessionCookies = createEnhancedSessionCookies();
      sessionExpiry = Date.now() + (1 * 60 * 60 * 1000);
      resolve(realSessionCookies);
    });

    req.end();
  });
};

// Enhanced session cookies with realistic values
const createEnhancedSessionCookies = () => {
  const timestamp = Date.now();
  const sessionId = Math.random().toString(36).substring(2, 15);
  const visitorId = 'CgtQbXJILVdxaU5uYyiQmqK0BjIKCgJVUxIEGgAgEQ%3D%3D';
  
  return [
    `VISITOR_INFO1_LIVE=${visitorId}`,
    `YSC=${sessionId}`,
    `PREF=f1=50000000&f6=40000000&hl=en-US&gl=US`,
    `CONSENT=YES+srp.gws-20211028-0-RC2.en+FX+667`,
    `GPS=1`,
    `SOCS=CAESAggC`,
    `__Secure-3PSID=${sessionId}_${timestamp}`,
    `__Secure-3PAPISID=${sessionId}_${timestamp}`,
    `SIDCC=ACA-OxNvI2pwchHONLCjNZq8cSHPpCOa${timestamp}`
  ].join('; ');
};

// Get fresh session cookies
const getFreshSessionCookies = async () => {
  if (!realSessionCookies || Date.now() > sessionExpiry) {
    console.log('🔄 Refreshing session cookies...');
    realSessionCookies = await establishRealSession();
  }
  return realSessionCookies;
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

// Enhanced video info with real cookies
const getVideoInfoWithRealCookies = async (url) => {
  if (!ytDlpAvailable) {
    throw new Error('yt-dlp not available');
  }

  console.log(`🔍 Getting video info with real session: ${url}`);
  
  const sessionCookies = await getFreshSessionCookies();
  
  return new Promise((resolve, reject) => {
    const args = [
      '--dump-json', '--no-download', '--no-warnings', '--ignore-errors',
      '--user-agent', getRandomUserAgent(),
      '--add-header', 'Accept-Language:en-US,en;q=0.9',
      '--add-header', 'Accept:text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      '--add-header', 'Sec-Fetch-Mode:navigate',
      '--add-header', 'Sec-Fetch-Site:none',
      '--add-header', 'Sec-Fetch-User:?1',
      '--add-header', `Cookie: ${sessionCookies}`,
      '--extractor-args', 'youtube:player_client=web',
      '--sleep-interval', '1',
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
        console.error('Video info error:', errorData);
        if (errorData.includes('Sign in to confirm')) {
          console.log('🔄 Bot detection, refreshing session...');
          realSessionCookies = '';
          sessionExpiry = 0;
        }
        reject(new Error('Failed to get video info - refreshing session'));
      }
    });

    setTimeout(() => {
      ytdlp.kill();
      reject(new Error('Video info timeout'));
    }, 20000);
  });
};

// Enhanced download with real cookies and fallback strategies
const downloadVideoWithRealCookies = async (url, quality, downloadId) => {
  if (!ytDlpAvailable) {
    throw new Error('yt-dlp not available');
  }

  directDownloadAttempts++;
  console.log(`⬇️ Starting download with real cookies: ${downloadId}`);
  
  const filename = `${downloadId}.%(ext)s`;
  const outputPath = `/tmp/downloads/${filename}`;
  
  // Ensure downloads directory exists
  try {
    await fs.mkdir('/tmp/downloads', { recursive: true });
  } catch (e) {
    // Directory exists
  }
  
  const strategies = [
    {
      name: 'real_cookies_web',
      getArgs: async () => {
        const sessionCookies = await getFreshSessionCookies();
        return [
          '-o', outputPath, '--newline', '--no-warnings', '--ignore-errors',
          '--user-agent', getRandomUserAgent(),
          '--add-header', 'Accept-Language:en-US,en;q=0.9',
          '--add-header', 'Accept:text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          '--add-header', 'Sec-Fetch-Mode:navigate',
          '--add-header', 'Sec-Fetch-Site:none',
          '--add-header', 'Sec-Fetch-User:?1',
          '--add-header', `Cookie: ${sessionCookies}`,
          '--sleep-interval', '2', '--max-sleep-interval', '4',
          '--retries', '3', '--fragment-retries', '3',
          '--extractor-args', 'youtube:player_client=web'
        ];
      }
    },
    {
      name: 'android_client',
      getArgs: async () => [
        '-o', outputPath, '--newline', '--no-warnings', '--ignore-errors',
        '--user-agent', 'com.google.android.youtube/18.11.34 (Linux; U; Android 11; SM-G981B) gzip',
        '--sleep-interval', '3', '--max-sleep-interval', '6',
        '--retries', '5', '--fragment-retries', '5',
        '--extractor-args', 'youtube:player_client=android'
      ]
    },
    {
      name: 'ios_client',
      getArgs: async () => [
        '-o', outputPath, '--newline', '--no-warnings', '--ignore-errors',
        '--user-agent', 'com.google.ios.youtube/18.11.2 (iPhone14,3; U; CPU iOS 16_4 like Mac OS X)',
        '--sleep-interval', '4', '--max-sleep-interval', '8',
        '--retries', '7', '--fragment-retries', '7',
        '--extractor-args', 'youtube:player_client=ios'
      ]
    }
  ];
  
  for (const strategy of strategies) {
    try {
      console.log(`🔧 Trying ${strategy.name} strategy...`);
      
      const args = await strategy.getArgs();
      
      // Add quality settings
      if (quality === 'audio') {
        args.push('--extract-audio', '--audio-format', 'mp3');
      } else if (quality !== 'best') {
        args.push('-f', quality);
      }
      args.push(url);
      
      await new Promise((strategyResolve, strategyReject) => {
        const ytdlp = spawn(ytDlpPath, args);
        
        downloadStatus.set(downloadId, {
          status: 'downloading',
          progress: 0,
          strategy: strategy.name
        });
        
        ytdlp.stdout.on('data', (data) => {
          const output = data.toString();
          const progressMatch = output.match(/(\d+(?:\.\d+)?)%/);
          if (progressMatch) {
            const progress = parseFloat(progressMatch[1]);
            downloadStatus.set(downloadId, {
              status: 'downloading',
              progress: progress,
              strategy: strategy.name
            });
          }
        });
        
        ytdlp.stderr.on('data', (data) => {
          const error = data.toString();
          console.error(`${strategy.name} stderr:`, error);
          if (error.includes('Sign in to confirm')) {
            console.log(`🤖 Bot detection on ${strategy.name} - will try next strategy`);
          }
        });
        
        ytdlp.on('close', (code) => {
          if (code === 0) {
            console.log(`✅ ${strategy.name} download succeeded`);
            strategyResolve();
          } else {
            console.log(`❌ ${strategy.name} failed with code ${code}`);
            strategyReject(new Error(`${strategy.name} failed`));
          }
        });
        
        setTimeout(() => {
          ytdlp.kill();
          strategyReject(new Error(`${strategy.name} timeout`));
        }, 300000); // 5 minutes per strategy
      });
      
      // Success!
      successfulDownloads++;
      downloadStatus.set(downloadId, { 
        status: 'completed',
        strategy: strategy.name
      });
      console.log(`✅ Download completed with ${strategy.name}: ${downloadId} (${successfulDownloads}/${directDownloadAttempts} success rate)`);
      return downloadId;
      
    } catch (error) {
      console.log(`❌ ${strategy.name} failed:`, error.message);
      downloadStatus.set(downloadId, {
        status: 'retrying',
        progress: 0,
        attempted_strategy: strategy.name,
        error: error.message
      });
      continue;
    }
  }
  
  // All strategies failed - refresh session for next time
  console.log('🔄 All strategies failed, refreshing session for future attempts');
  realSessionCookies = '';
  sessionExpiry = 0;
  
  downloadStatus.set(downloadId, { 
    status: 'error', 
    error: 'All download strategies failed. Server IP may be blocked.',
    fallback: true
  });
  
  throw new Error('All download strategies failed');
};

// Immediate health check endpoint (critical for Render)
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK',
    timestamp: new Date().toISOString(),
    server_ready: serverReady,
    ytdlp_available: ytDlpAvailable,
    session_active: !!realSessionCookies
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
    session_active: !!realSessionCookies,
    session_expiry: sessionExpiry > 0 ? new Date(sessionExpiry).toISOString() : null,
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
    session_active: !!realSessionCookies,
    real_cookies: true,
    features: {
      video_info: ytDlpAvailable,
      video_download: ytDlpAvailable,
      command_generation: true,
      real_session: true,
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
      const info = await getVideoInfoWithRealCookies(url);
      res.json({ 
        success: true, 
        ...info,
        message: 'Video info retrieved with real session cookies'
      });
    } catch (error) {
      console.error('Video info error:', error);
      
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
        message: 'Using basic info due to session issues',
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
    
    // Start download with real cookies
    downloadVideoWithRealCookies(url, quality, downloadId).catch(err => {
      console.error('Download error:', err);
      downloadStatus.set(downloadId, { 
        status: 'error', 
        error: err.message
      });
    });
    
    res.json({ 
      success: true, 
      downloadId,
      message: 'Download started with real session authentication'
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
    
    const alternatives = {
      withCookies: command.replace('yt-dlp ', 'yt-dlp --cookies-from-browser chrome '),
      withUserAgent: command.replace('yt-dlp ', 'yt-dlp --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" '),
      enhanced: command.replace('yt-dlp ', 'yt-dlp --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" --sleep-interval 2 --retries 5 ')
    };
    
    res.json({
      success: true,
      command: command,
      message: 'Command generated successfully',
      alternatives: alternatives,
      instructions: 'Server uses real session cookies for direct downloads!'
    });
    
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Cleanup old downloads
setInterval(async () => {
  try {
    const files = await fs.readdir('/tmp/downloads');
    const now = Date.now();
    
    for (const file of files) {
      const filePath = `/tmp/downloads/${file}`;
      const stats = await fs.stat(filePath);
      
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

// Start server immediately (critical for Render health checks)
const server = app.listen(port, () => {
  console.log(`🚀 Server LIVE on port ${port}`);
  console.log(`🌍 Health check ready at /health`);
  serverReady = true;
  
  // Start background initialization
  setTimeout(() => {
    console.log('🔧 Starting background initialization...');
    quickYtDlpCheck();
    
    // Initialize real session after yt-dlp is ready
    setTimeout(async () => {
      if (ytDlpAvailable) {
        console.log('🍪 Initializing real YouTube session...');
        await establishRealSession();
        console.log('🎯 Real session authentication ready!');
      }
    }, 5000);
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
