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

// Global variables
const downloadStatus = new Map();
let ytDlpAvailable = false;
let ytDlpPath = 'yt-dlp';
let directDownloadAttempts = 0;
let successfulDownloads = 0;

// Enhanced User Agents for rotation
const userAgents = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
];

let currentUserAgentIndex = 0;

// Get rotating user agent
const getRandomUserAgent = () => {
  const agent = userAgents[currentUserAgentIndex];
  currentUserAgentIndex = (currentUserAgentIndex + 1) % userAgents.length;
  return agent;
};

// Create realistic session cookies (simple approach)
const createSessionCookies = () => {
  const sessionId = Math.random().toString(36).substring(2, 15);
  const timestamp = Date.now();
  
  // Basic session cookies that look realistic
  return [
    `VISITOR_INFO1_LIVE=${sessionId}_${timestamp}`,
    `YSC=${sessionId}`,
    `PREF=f1=50000000&f6=40000000&hl=en`,
    `CONSENT=YES+cb.20210328-17-p0.en+FX+667`,
    `GPS=1`
  ].join('; ');
};

// Install yt-dlp
const tryInstallYtDlp = async () => {
  console.log('🔧 Installing yt-dlp...');
  
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
      name: 'direct download',
      command: 'curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /tmp/yt-dlp && chmod +x /tmp/yt-dlp && /tmp/yt-dlp --version',
      timeout: 30000,
      path: '/tmp/yt-dlp'
    }
  ];

  for (const method of methods) {
    try {
      console.log(`🔧 Trying: ${method.name}...`);
      
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Timeout'));
        }, method.timeout);

        exec(method.command, (error, stdout, stderr) => {
          clearTimeout(timeout);
          if (error) {
            reject(error);
          } else {
            ytDlpPath = method.path;
            resolve(stdout);
          }
        });
      });

      ytDlpAvailable = true;
      console.log(`✅ yt-dlp available at: ${ytDlpPath}`);
      return;
      
    } catch (error) {
      console.log(`❌ ${method.name} failed, trying next...`);
      continue;
    }
  }
  
  console.log('⚠️  yt-dlp installation failed');
  ytDlpAvailable = false;
};

// Extract video ID from URL
const extractVideoId = (url) => {
  const regex = /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/;
  const match = url.match(regex);
  return match ? match[1] : null;
};

// Enhanced video info with multiple anti-detection strategies
const getVideoInfo = async (url) => {
  return new Promise(async (resolve, reject) => {
    if (!ytDlpAvailable) {
      reject(new Error('yt-dlp not available'));
      return;
    }

    console.log(`🔍 Getting video info with enhanced anti-detection: ${url}`);
    
    // Try multiple strategies
    const strategies = [
      {
        name: 'web_enhanced',
        args: [
          '--dump-json', '--no-download', '--no-warnings', '--ignore-errors',
          '--user-agent', getRandomUserAgent(),
          '--add-header', 'Accept-Language:en-US,en;q=0.9',
          '--add-header', 'Accept:text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          '--add-header', 'Sec-Fetch-Mode:navigate',
          '--add-header', 'Sec-Fetch-Site:none',
          '--add-header', 'Sec-Fetch-User:?1',
          '--add-header', `Cookie: ${createSessionCookies()}`,
          '--extractor-args', 'youtube:player_client=web',
          '--sleep-interval', '1',
          url
        ]
      },
      {
        name: 'android_client',
        args: [
          '--dump-json', '--no-download', '--no-warnings', '--ignore-errors',
          '--user-agent', 'com.google.android.youtube/18.11.34 (Linux; U; Android 11; SM-G981B) gzip',
          '--extractor-args', 'youtube:player_client=android',
          '--sleep-interval', '2',
          url
        ]
      },
      {
        name: 'ios_client',
        args: [
          '--dump-json', '--no-download', '--no-warnings', '--ignore-errors',
          '--user-agent', 'com.google.ios.youtube/18.11.2 (iPhone14,3; U; CPU iOS 16_4 like Mac OS X)',
          '--extractor-args', 'youtube:player_client=ios',
          '--sleep-interval', '2',
          url
        ]
      }
    ];
    
    for (const strategy of strategies) {
      try {
        console.log(`🔧 Trying ${strategy.name} strategy...`);
        
        const info = await new Promise((strategyResolve, strategyReject) => {
          const ytdlp = spawn(ytDlpPath, strategy.args);
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
                const parsed = JSON.parse(data.trim());
                strategyResolve(parsed);
              } catch (parseError) {
                strategyReject(new Error('Parse error'));
              }
            } else {
              strategyReject(new Error(`Strategy failed: ${errorData}`));
            }
          });

          setTimeout(() => {
            ytdlp.kill();
            strategyReject(new Error('Strategy timeout'));
          }, 20000);
        });
        
        console.log(`✅ ${strategy.name} strategy succeeded`);
        resolve({
          title: info.title || 'Unknown Title',
          duration: info.duration || 0,
          uploader: info.uploader || 'Unknown Uploader',
          view_count: info.view_count || 0,
          thumbnail: info.thumbnail || '',
          webpage_url: info.webpage_url || url,
          strategy_used: strategy.name
        });
        return;
        
      } catch (error) {
        console.log(`❌ ${strategy.name} failed:`, error.message);
        continue;
      }
    }
    
    console.log('🤖 All strategies failed - using fallback');
    reject(new Error('All anti-detection strategies failed'));
  });
};

// Enhanced download with multiple strategies
const downloadVideo = async (url, quality, downloadId) => {
  return new Promise(async (resolve, reject) => {
    if (!ytDlpAvailable) {
      reject(new Error('yt-dlp not available'));
      return;
    }

    directDownloadAttempts++;
    console.log(`⬇️ Starting enhanced download: ${downloadId}`);
    
    const filename = `${downloadId}.%(ext)s`;
    const outputPath = path.join(TEMP_DIR, filename);
    
    // Enhanced download strategies
    const strategies = [
      {
        name: 'enhanced_web',
        args: [
          '-o', outputPath, '--newline', '--no-warnings', '--ignore-errors',
          '--user-agent', getRandomUserAgent(),
          '--add-header', 'Accept-Language:en-US,en;q=0.9',
          '--add-header', 'Accept:text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          '--add-header', 'Sec-Fetch-Mode:navigate',
          '--add-header', 'Sec-Fetch-Site:none',
          '--add-header', 'Sec-Fetch-User:?1',
          '--add-header', `Cookie: ${createSessionCookies()}`,
          '--sleep-interval', '2', '--max-sleep-interval', '4',
          '--retries', '3', '--fragment-retries', '3',
          '--extractor-args', 'youtube:player_client=web'
        ]
      },
      {
        name: 'android_fallback',
        args: [
          '-o', outputPath, '--newline', '--no-warnings', '--ignore-errors',
          '--user-agent', 'com.google.android.youtube/18.11.34 (Linux; U; Android 11; SM-G981B) gzip',
          '--sleep-interval', '3', '--max-sleep-interval', '6',
          '--retries', '5', '--fragment-retries', '5',
          '--extractor-args', 'youtube:player_client=android'
        ]
      },
      {
        name: 'ios_fallback',
        args: [
          '-o', outputPath, '--newline', '--no-warnings', '--ignore-errors',
          '--user-agent', 'com.google.ios.youtube/18.11.2 (iPhone14,3; U; CPU iOS 16_4 like Mac OS X)',
          '--sleep-interval', '4', '--max-sleep-interval', '8',
          '--retries', '7', '--fragment-retries', '7',
          '--extractor-args', 'youtube:player_client=ios'
        ]
      }
    ];
    
    // Add quality settings to all strategies
    for (const strategy of strategies) {
      if (quality === 'audio') {
        strategy.args.push('--extract-audio', '--audio-format', 'mp3');
      } else if (quality !== 'best') {
        strategy.args.push('-f', quality);
      }
      strategy.args.push(url);
    }
    
    // Try each strategy
    for (const strategy of strategies) {
      try {
        console.log(`🔧 Trying ${strategy.name} download strategy...`);
        
        await new Promise((strategyResolve, strategyReject) => {
          const ytdlp = spawn(ytDlpPath, strategy.args);
          
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
            if (error.includes('Sign in to confirm') || 
                error.includes('bot') || 
                error.includes('authentication')) {
              console.log(`🤖 Bot detection on ${strategy.name}`);
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
          }, 600000); // 10 minutes
        });
        
        // Success!
        successfulDownloads++;
        downloadStatus.set(downloadId, { 
          status: 'completed',
          strategy: strategy.name
        });
        console.log(`✅ Download completed with ${strategy.name}: ${downloadId}`);
        resolve(downloadId);
        return;
        
      } catch (error) {
        console.log(`❌ ${strategy.name} download failed:`, error.message);
        downloadStatus.set(downloadId, {
          status: 'retrying',
          progress: 0,
          attempted_strategy: strategy.name,
          error: error.message
        });
        continue;
      }
    }
    
    // All strategies failed
    downloadStatus.set(downloadId, { 
      status: 'error', 
      error: 'All download strategies failed',
      fallback: true
    });
    reject(new Error('All download strategies failed'));
  });
};

// API Routes
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    ytdlp_available: ytDlpAvailable,
    ytdlp_path: ytDlpPath,
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
    anti_detection: true,
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
        message: 'yt-dlp not available, using basic info'
      });
    }
    
    try {
      const info = await getVideoInfo(url);
      res.json({ 
        success: true, 
        ...info,
        message: 'Video info retrieved with multi-strategy anti-detection'
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
        message: 'Using basic info due to detection issues',
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
        error: 'yt-dlp not available on server',
        fallback: true
      });
    }
    
    const downloadId = uuidv4();
    downloadStatus.set(downloadId, { status: 'starting' });
    
    // Start download with multiple strategies
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
      message: 'Download started with multi-strategy anti-detection'
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
    
    const files = await fs.readdir(TEMP_DIR);
    const downloadedFile = files.find(file => file.startsWith(downloadId));
    
    if (!downloadedFile) {
      return res.status(404).json({ 
        error: 'File not found' 
      });
    }
    
    const filePath = path.join(TEMP_DIR, downloadedFile);
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

// Enhanced command generation
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
      withUserAgent: command.replace('yt-dlp ', 'yt-dlp --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" '),
      withCookies: command.replace('yt-dlp ', 'yt-dlp --cookies-from-browser chrome '),
      enhanced: command.replace('yt-dlp ', 'yt-dlp --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" --sleep-interval 2 --retries 5 ')
    };
    
    res.json({
      success: true,
      command: command,
      message: 'Command generated successfully',
      alternatives: alternatives,
      instructions: 'Server uses multi-strategy anti-detection for direct downloads!'
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
    const files = await fs.readdir(TEMP_DIR);
    const now = Date.now();
    
    for (const file of files) {
      const filePath = path.join(TEMP_DIR, file);
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

// Initialize server
const startServer = async () => {
  console.log('🚀 Starting YouTube Downloader with Enhanced Anti-Detection...');
  
  const server = app.listen(port, () => {
    console.log(`🌟 Server running on port ${port}`);
    console.log(`🌍 Server is LIVE and ready for requests!`);
  });
  
  setTimeout(async () => {
    try {
      await ensureTempDir();
      await tryInstallYtDlp();
      
      if (ytDlpAvailable) {
        console.log(`📱 Multi-strategy anti-detection ready!`);
        console.log(`🔄 User agent rotation: ${userAgents.length} agents`);
        console.log(`🍪 Session cookie generation: Active`);
      } else {
        console.log('⚠️  yt-dlp not available - command generation only');
      }
      
    } catch (error) {
      console.log('⚠️  Initialization completed with limitations');
    }
  }, 2000);
  
  return server;
};

// Start the server
startServer().catch(error => {
  console.error('❌ Server startup failed:', error);
  app.listen(port, () => {
    console.log(`🆘 Emergency server running on port ${port}`);
  });
});

process.on('SIGTERM', () => {
  console.log('👋 Shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('👋 Shutting down gracefully...');
  process.exit(0);
});
