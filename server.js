const express = require('express');
const compression = require('compression');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs').promises;
const { spawn, exec } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const puppeteer = require('puppeteer');

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

// Cookie authentication variables
let browserInstance = null;
let youtubeCookies = null;
let cookieExpiry = null;
let cookieString = null;

// Initialize browser and get YouTube cookies
const initializeBrowser = async () => {
  try {
    console.log('🌐 Initializing browser for cookie extraction...');
    
    browserInstance = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor'
      ]
    });
    
    const page = await browserInstance.newPage();
    
    // Set realistic headers and viewport
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1920, height: 1080 });
    
    // Set additional headers
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
    });
    
    // Visit YouTube to establish session
    console.log('📺 Visiting YouTube to establish authenticated session...');
    await page.goto('https://www.youtube.com/', { 
      waitUntil: 'networkidle2',
      timeout: 60000 
    });
    
    // Wait for page to fully load
    await page.waitForTimeout(5000);
    
    // Try to interact with the page to seem more human
    try {
      await page.evaluate(() => {
        window.scrollBy(0, 100);
      });
      await page.waitForTimeout(2000);
    } catch (e) {
      // Ignore interaction errors
    }
    
    // Get cookies
    const cookies = await page.cookies();
    console.log(`🍪 Extracted ${cookies.length} cookies from YouTube`);
    
    // Convert cookies to different formats
    youtubeCookies = cookies;
    
    // Create cookie string for headers
    cookieString = cookies.map(cookie => {
      return `${cookie.name}=${cookie.value}`;
    }).join('; ');
    
    // Create Netscape cookie format for yt-dlp
    const netscapeCookies = cookies.map(cookie => {
      return `${cookie.domain}\t${cookie.httpOnly ? 'FALSE' : 'TRUE'}\t${cookie.path}\t${cookie.secure ? 'TRUE' : 'FALSE'}\t${cookie.expires ? Math.floor(cookie.expires) : '0'}\t${cookie.name}\t${cookie.value}`;
    }).join('\n');
    
    // Save cookies to file for yt-dlp
    const cookiesPath = path.join(TEMP_DIR, 'youtube_cookies.txt');
    await fs.writeFile(cookiesPath, '# Netscape HTTP Cookie File\n' + netscapeCookies);
    
    cookieExpiry = Date.now() + (6 * 60 * 60 * 1000); // Expire in 6 hours
    
    await page.close();
    console.log('✅ Browser session established and cookies saved');
    
  } catch (error) {
    console.error('❌ Browser initialization failed:', error);
    if (browserInstance) {
      try {
        await browserInstance.close();
      } catch (e) {
        // Ignore close errors
      }
      browserInstance = null;
    }
  }
};

// Get fresh cookies if needed
const getFreshCookies = async () => {
  if (!youtubeCookies || !cookieExpiry || Date.now() > cookieExpiry) {
    console.log('🔄 Refreshing YouTube cookies...');
    await initializeBrowser();
  }
  return path.join(TEMP_DIR, 'youtube_cookies.txt');
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

// Get video info with cookie authentication
const getVideoInfo = async (url) => {
  return new Promise(async (resolve, reject) => {
    if (!ytDlpAvailable) {
      reject(new Error('yt-dlp not available'));
      return;
    }

    console.log(`🔍 Getting video info with cookie authentication: ${url}`);
    
    try {
      // Get fresh cookies
      const cookiesPath = await getFreshCookies();
      
      const args = [
        '--dump-json', 
        '--no-download',
        '--no-warnings',
        '--ignore-errors',
        '--cookies', cookiesPath,
        '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        '--add-header', 'Accept-Language:en-US,en;q=0.9',
        '--add-header', 'Accept:text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
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
            console.error('JSON parse error:', parseError);
            reject(new Error('Failed to parse video info'));
          }
        } else {
          console.error('Video info error:', errorData);
          if (errorData.includes('Sign in to confirm')) {
            console.log('🔄 Authentication failed, refreshing cookies...');
            youtubeCookies = null;
            cookieExpiry = null;
            reject(new Error('Authentication failed - will refresh cookies'));
          } else {
            reject(new Error('Failed to get video info: ' + errorData));
          }
        }
      });

      setTimeout(() => {
        ytdlp.kill();
        reject(new Error('Video info request timed out'));
      }, 45000);
      
    } catch (error) {
      reject(error);
    }
  });
};

// Download video with cookie authentication
const downloadVideo = async (url, quality, downloadId) => {
  return new Promise(async (resolve, reject) => {
    if (!ytDlpAvailable) {
      reject(new Error('yt-dlp not available'));
      return;
    }

    directDownloadAttempts++;
    console.log(`⬇️ Starting authenticated download: ${downloadId}`);
    
    try {
      // Get fresh cookies
      const cookiesPath = await getFreshCookies();
      
      const filename = `${downloadId}.%(ext)s`;
      const outputPath = path.join(TEMP_DIR, filename);
      
      const args = [
        '-o', outputPath,
        '--newline',
        '--no-warnings',
        '--ignore-errors',
        '--cookies', cookiesPath,
        '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        '--add-header', 'Accept-Language:en-US,en;q=0.9',
        '--add-header', 'Accept:text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        '--add-header', 'Sec-Fetch-Mode:navigate',
        '--add-header', 'Sec-Fetch-Site:none',
        '--sleep-interval', '1',
        '--max-sleep-interval', '3',
        '--retries', '3',
        '--fragment-retries', '3',
        '--extractor-args', 'youtube:player_client=web'
      ];
      
      // Quality settings
      if (quality === 'audio') {
        args.push('--extract-audio', '--audio-format', 'mp3');
      } else if (quality !== 'best') {
        args.push('-f', quality);
      }
      
      args.push(url);
      
      console.log('🍪 Starting download with cookie authentication...');
      const ytdlp = spawn(ytDlpPath, args);
      
      ytdlp.stdout.on('data', (data) => {
        const output = data.toString();
        console.log('Download output:', output);
        
        // Parse progress
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
        const error = data.toString();
        console.error('Download stderr:', error);
        
        if (error.includes('Sign in to confirm')) {
          console.log('🤖 Authentication failed during download, refreshing cookies...');
          youtubeCookies = null;
          cookieExpiry = null;
        }
      });
      
      ytdlp.on('close', (code) => {
        if (code === 0) {
          successfulDownloads++;
          downloadStatus.set(downloadId, { status: 'completed' });
          console.log(`✅ Authenticated download completed: ${downloadId} (${successfulDownloads}/${directDownloadAttempts} success rate)`);
          resolve(downloadId);
        } else {
          const errorMsg = `Download failed with code ${code}`;
          downloadStatus.set(downloadId, { 
            status: 'error', 
            error: errorMsg
          });
          console.error(`❌ ${errorMsg}`);
          reject(new Error(errorMsg));
        }
      });
      
      // Timeout after 10 minutes
      setTimeout(() => {
        ytdlp.kill();
        downloadStatus.set(downloadId, { 
          status: 'error', 
          error: 'Download timed out'
        });
        reject(new Error('Download timeout'));
      }, 600000);
      
    } catch (error) {
      downloadStatus.set(downloadId, { 
        status: 'error', 
        error: error.message
      });
      reject(error);
    }
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
    cookie_auth: !!youtubeCookies,
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
    cookie_authentication: !!youtubeCookies,
    features: {
      video_info: ytDlpAvailable,
      video_download: ytDlpAvailable,
      command_generation: true,
      cookie_auth: !!youtubeCookies
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
        message: 'Video info retrieved with authentication'
      });
    } catch (error) {
      console.error('Video info error:', error);
      
      // Fallback to basic info
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
        message: 'Using basic info due to authentication issues',
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
    
    // Start download with cookie authentication
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
      message: 'Download started with cookie authentication'
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
      withCookies: command.replace('yt-dlp ', 'yt-dlp --cookies-from-browser chrome '),
      withUserAgent: command.replace('yt-dlp ', 'yt-dlp --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" ')
    };
    
    res.json({
      success: true,
      command: command,
      message: 'Command generated successfully',
      alternatives: alternatives,
      instructions: 'Server now uses cookie authentication for direct downloads!'
    });
    
  } catch (error) {
    res.status(500).json({ 
      success: false, 
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
      if (file === 'youtube_cookies.txt') continue; // Don't delete cookies
      
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

// Initialize server
const startServer = async () => {
  console.log('🚀 Starting YouTube Downloader with Cookie Authentication...');
  
  // Start server immediately
  const server = app.listen(port, () => {
    console.log(`🌟 Server running on port ${port}`);
    console.log(`🌍 Server is LIVE and ready for requests!`);
  });
  
  // Initialize components in background
  setTimeout(async () => {
    try {
      await ensureTempDir();
      await tryInstallYtDlp();
      
      if (ytDlpAvailable) {
        console.log('🍪 Initializing cookie authentication...');
        await initializeBrowser();
        console.log(`📱 Server ready with cookie authentication!`);
      } else {
        console.log('⚠️  yt-dlp not available - limited functionality');
      }
      
    } catch (error) {
      console.log('⚠️  Initialization completed with some limitations');
    }
  }, 2000);
  
  return server;
};

// Cleanup on shutdown
process.on('SIGTERM', async () => {
  console.log('👋 Shutting down gracefully...');
  if (browserInstance) {
    try {
      await browserInstance.close();
    } catch (e) {
      // Ignore errors
    }
  }
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('👋 Shutting down gracefully...');
  if (browserInstance) {
    try {
      await browserInstance.close();
    } catch (e) {
      // Ignore errors
    }
  }
  process.exit(0);
});

// Start the server
startServer().catch(error => {
  console.error('❌ Server startup failed:', error);
  app.listen(port, () => {
    console.log(`🆘 Emergency server running on port ${port}`);
  });
});
