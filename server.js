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

// Cookie file management
let cookieFilePath = '/tmp/youtube_cookies.txt';
let cookieFileExpiry = 0;

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

// FIXED: Create Netscape cookie file format with correct domain_specified values
const createNetscapeCookieFile = async (cookies) => {
  const cookieLines = [
    '# Netscape HTTP Cookie File',
    '# This is a generated file! Do not edit.'
  ];
  
  cookies.forEach(cookie => {
    const parts = cookie.split('=');
    if (parts.length >= 2) {
      const name = parts[0].trim();
      const value = parts.slice(1).join('=').trim();
      const expires = Math.floor(Date.now() / 1000) + (24 * 60 * 60); // 24 hours from now
      
      // FIXED: Format: domain, domain_specified, path, secure, expires, name, value
      // domain_specified should be FALSE for main domain, TRUE for subdomains starting with dot
      cookieLines.push(`youtube.com\tFALSE\t/\tFALSE\t${expires}\t${name}\t${value}`);
      cookieLines.push(`.youtube.com\tTRUE\t/\tFALSE\t${expires}\t${name}\t${value}`);
    }
  });
  
  try {
    // FIXED: Add final newline to cookie file
    await fs.writeFile(cookieFilePath, cookieLines.join('\n') + '\n');
    cookieFileExpiry = Date.now() + (2 * 60 * 60 * 1000); // 2 hours
    console.log(`✅ Cookie file created with ${cookies.length} cookies`);
    return true;
  } catch (error) {
    console.error('❌ Failed to create cookie file:', error);
    return false;
  }
};

// Enhanced cookie file with more realistic browser session
const createRealisticCookieFile = async () => {
  const timestamp = Math.floor(Date.now() / 1000);
  const randomSuffix = Math.random().toString(36).substring(2, 8);
  const sessionId = `${randomSuffix}${timestamp.toString().slice(-6)}`;
  
  // More realistic visitor ID
  const visitorComponents = [
    Math.random().toString(36).substring(2, 10),
    Math.random().toString(36).substring(2, 8),
    'BjI', // Common pattern
    Math.random().toString(36).substring(2, 6).toUpperCase()
  ];
  const visitorId = btoa(visitorComponents.join('')).replace(/[+/=]/g, match => {
    return { '+': '-', '/': '_', '=': '' }[match];
  });
  
  const cookieLines = [
    '# Netscape HTTP Cookie File',
    '# This is a generated file! Do not edit.',
    '',
    // Essential YouTube cookies with realistic values
    `youtube.com\tFALSE\t/\tFALSE\t${timestamp + 31536000}\tVISITOR_INFO1_LIVE\t${visitorId}`,
    `.youtube.com\tTRUE\t/\tFALSE\t${timestamp + 31536000}\tVISITOR_INFO1_LIVE\t${visitorId}`,
    `youtube.com\tFALSE\t/\tFALSE\t${timestamp + 86400}\tYSC\t${sessionId}`,
    `.youtube.com\tTRUE\t/\tFALSE\t${timestamp + 86400}\tYSC\t${sessionId}`,
    `youtube.com\tFALSE\t/\tFALSE\t${timestamp + 31536000}\tPREF\tf4=4000000&f5=30000&hl=en&gl=US`,
    `.youtube.com\tTRUE\t/\tFALSE\t${timestamp + 31536000}\tPREF\tf4=4000000&f5=30000&hl=en&gl=US`,
    `youtube.com\tFALSE\t/\tFALSE\t${timestamp + 31536000}\tCONSENT\tYES+cb.20210328-17-p0.en+FX+${Math.floor(Math.random() * 1000)}`,
    `.youtube.com\tTRUE\t/\tFALSE\t${timestamp + 31536000}\tCONSENT\tYES+cb.20210328-17-p0.en+FX+${Math.floor(Math.random() * 1000)}`,
    // Add some Google-wide cookies for authenticity
    `google.com\tFALSE\t/\tFALSE\t${timestamp + 31536000}\tNID\t${Math.random().toString(36).substring(2, 30)}`,
    `.google.com\tTRUE\t/\tFALSE\t${timestamp + 31536000}\tNID\t${Math.random().toString(36).substring(2, 30)}`
  ];
  
  try {
    await fs.writeFile(cookieFilePath, cookieLines.join('\n') + '\n');
    cookieFileExpiry = Date.now() + (4 * 60 * 60 * 1000); // 4 hours
    console.log('✅ Realistic cookie file created');
    return true;
  } catch (error) {
    console.error('❌ Failed to create realistic cookie file:', error);
    return false;
  }
};

// Update the fallback function call
const createFallbackCookieFile = async () => {
  return await createRealisticCookieFile();
};

// Establish real YouTube session and create cookie file
const establishRealSessionFile = async () => {
  return new Promise((resolve, reject) => {
    console.log('🍪 Establishing real YouTube session...');
    
    const options = {
      hostname: 'www.youtube.com',
      port: 443,
      path: '/',
      method: 'GET',
      headers: {
        'User-Agent': getRandomUserAgent(),
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

    const req = https.request(options, async (res) => {
      let cookies = [];
      
      // Extract cookies from response headers
      if (res.headers['set-cookie']) {
        cookies = res.headers['set-cookie'].map(cookie => {
          return cookie.split(';')[0]; // Get just the name=value part
        });
      }
      
      res.on('data', () => {}); // Consume data
      
      res.on('end', async () => {
        if (cookies.length > 0) {
          const success = await createNetscapeCookieFile(cookies);
          if (success) {
            console.log(`✅ Real session file created with ${cookies.length} cookies`);
            resolve(true);
          } else {
            console.log('⚠️  Real cookies failed, using fallback');
            const fallbackSuccess = await createFallbackCookieFile();
            resolve(fallbackSuccess);
          }
        } else {
          console.log('⚠️  No cookies received, using fallback');
          const fallbackSuccess = await createFallbackCookieFile();
          resolve(fallbackSuccess);
        }
      });
    });

    req.on('error', async (err) => {
      console.error('Session establishment error:', err);
      const fallbackSuccess = await createFallbackCookieFile();
      resolve(fallbackSuccess);
    });
    
    req.setTimeout(8000, async () => {
      console.log('⚠️  Session request timeout, using fallback');
      req.destroy();
      const fallbackSuccess = await createFallbackCookieFile();
      resolve(fallbackSuccess);
    });

    req.end();
  });
};

// Get fresh cookie file
const getFreshCookieFile = async () => {
  // Check if cookie file exists and is not expired
  try {
    const stats = await fs.stat(cookieFilePath);
    if (Date.now() < cookieFileExpiry && stats.size > 0) {
      return cookieFilePath;
    }
  } catch (error) {
    // File doesn't exist, create new one
  }
  
  console.log('🔄 Refreshing cookie file...');
  const success = await establishRealSessionFile();
  return success ? cookieFilePath : null;
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

// Enhanced video info with cookie file
const getVideoInfoWithCookieFile = async (url) => {
  if (!ytDlpAvailable) {
    throw new Error('yt-dlp not available');
  }

  console.log(`🔍 Getting video info with cookie file: ${url}`);
  
  const cookieFile = await getFreshCookieFile();
  
  return new Promise((resolve, reject) => {
    const args = [
      '--dump-json', '--no-download', '--no-warnings', '--ignore-errors',
      '--user-agent', getRandomUserAgent(),
      '--extractor-args', 'youtube:player_client=web'
    ];
    
    // Add cookie file if available
    if (cookieFile) {
      args.push('--cookies', cookieFile);
    }
    
    args.push(url);
    
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
          console.log('🔄 Bot detection, will refresh cookie file');
          cookieFileExpiry = 0; // Force refresh next time
        }
        reject(new Error('Failed to get video info'));
      }
    });

    // Reduced timeout for faster response
    setTimeout(() => {
      ytdlp.kill();
      reject(new Error('Video info timeout'));
    }, 12000);
  });
};

// Enhanced download with better bot detection evasion
const downloadVideoWithCookieFile = async (url, quality, downloadId) => {
  if (!ytDlpAvailable) {
    throw new Error('yt-dlp not available');
  }

  directDownloadAttempts++;
  console.log(`⬇️ Starting download with enhanced bot evasion: ${downloadId}`);
  
  const filename = `${downloadId}.%(ext)s`;
  const outputPath = `/tmp/downloads/${filename}`;
  
  // Ensure downloads directory exists
  try {
    await fs.mkdir('/tmp/downloads', { recursive: true });
  } catch (e) {
    // Directory exists
  }
  
  // Enhanced strategies with better bot evasion
  const strategies = [
    {
      name: 'enhanced_web',
      getArgs: async () => {
        const cookieFile = await getFreshCookieFile();
        const args = [
          '-o', outputPath, '--newline', '--no-warnings', '--ignore-errors',
          '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
          '--sleep-interval', '3', '--max-sleep-interval', '8',
          '--retries', '5', '--fragment-retries', '5',
          '--extractor-args', 'youtube:player_client=web',
          '--add-header', 'Accept-Language:en-US,en;q=0.9',
          '--add-header', 'Accept:text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          '--add-header', 'DNT:1',
          '--add-header', 'Upgrade-Insecure-Requests:1'
        ];
        
        if (cookieFile) {
          args.push('--cookies', cookieFile);
        }
        
        return args;
      }
    },
    {
      name: 'android_tv',
      getArgs: async () => [
        '-o', outputPath, '--newline', '--no-warnings', '--ignore-errors',
        '--user-agent', 'com.google.android.youtube/18.11.34 (Linux; U; Android 11; SHIELD Android TV) gzip',
        '--sleep-interval', '4', '--max-sleep-interval', '10',
        '--retries', '5', '--fragment-retries', '5',
        '--extractor-args', 'youtube:player_client=android_testsuite'
      ]
    },
    {
      name: 'web_embedded',
      getArgs: async () => {
        const cookieFile = await getFreshCookieFile();
        const args = [
          '-o', outputPath, '--newline', '--no-warnings', '--ignore-errors',
          '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
          '--sleep-interval', '5', '--max-sleep-interval', '12',
          '--retries', '3', '--fragment-retries', '3',
          '--extractor-args', 'youtube:player_client=web_embedded',
          '--add-header', 'Referer:https://www.youtube.com/'
        ];
        
        if (cookieFile) {
          args.push('--cookies', cookieFile);
        }
        
        return args;
      }
    },
    {
      name: 'age_gate_bypass',
      getArgs: async () => [
        '-o', outputPath, '--newline', '--no-warnings', '--ignore-errors',
        '--user-agent', 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        '--sleep-interval', '6', '--max-sleep-interval', '15',
        '--retries', '3', '--fragment-retries', '3',
        '--extractor-args', 'youtube:player_client=web_music'
      ]
    },
    {
      name: 'fallback_generic',
      getArgs: async () => [
        '-o', outputPath, '--newline', '--no-warnings', '--ignore-errors',
        '--user-agent', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        '--sleep-interval', '8', '--max-sleep-interval', '20',
        '--retries', '2', '--fragment-retries', '2',
        '--force-generic-extractor'
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
          console.log(`${strategy.name} output:`, output.trim());
          
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
          console.error(`${strategy.name} stderr:`, error.trim());
          
          if (error.includes('Sign in to confirm') || error.includes('not a bot')) {
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
        
        // Longer timeout for slower strategies
        setTimeout(() => {
          ytdlp.kill();
          strategyReject(new Error(`${strategy.name} timeout`));
        }, 240000); // 4 minutes per strategy
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
      
      // Add delay between failed strategies to avoid rapid requests
      if (strategy.name !== 'fallback_generic') {
        console.log('⏳ Waiting 10 seconds before next strategy...');
        await new Promise(resolve => setTimeout(resolve, 10000));
      }
      continue;
    }
  }
  
  // All strategies failed - provide fallback options
  console.log('🔄 All strategies failed, providing fallback instructions');
  cookieFileExpiry = 0; // Force refresh next time
  
  downloadStatus.set(downloadId, { 
    status: 'error', 
    error: 'Server detected as bot by YouTube. Use manual command instead.',
    fallback: true,
    manual_command: `yt-dlp --cookies-from-browser chrome "${url}"`
  });
  
  throw new Error('All download strategies failed - server detected as bot');
};

// Immediate health check endpoint (critical for Render)
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
    cookie_file_active: Date.now() < cookieFileExpiry,
    cookie_file_path: cookieFilePath,
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
    cookie_file_active: Date.now() < cookieFileExpiry,
    cookie_authentication: true,
    features: {
      video_info: ytDlpAvailable,
      video_download: ytDlpAvailable,
      command_generation: true,
      cookie_file: true,
      multi_strategy: true
    },
    download_stats: {
      attempts: directDownloadAttempts,
      successful: successfulDownloads,
      success_rate: directDownloadAttempts > 0 ? (successfulDownloads / directDownloadAttempts * 100).toFixed(1) + '%' : 'N/A'
    }
  });
});

// New endpoint for bot detection status
app.get('/api/bot-status', (req, res) => {
  const recentAttempts = directDownloadAttempts;
  const recentSuccesses = successfulDownloads;
  const successRate = recentAttempts > 0 ? (recentSuccesses / recentAttempts * 100) : 0;
  
  res.json({
    bot_detected: successRate < 20, // Consider bot detected if success rate below 20%
    success_rate: successRate.toFixed(1) + '%',
    total_attempts: recentAttempts,
    successful_downloads: recentSuccesses,
    recommendation: successRate < 20 ? 
      'Use manual commands with browser cookies due to bot detection' : 
      'Server downloads working normally',
    manual_command_needed: successRate < 20
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
      const info = await getVideoInfoWithCookieFile(url);
      res.json({ 
        success: true, 
        ...info,
        message: 'Video info retrieved with cookie file authentication'
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
        message: 'Using basic info due to API limitations',
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
    
    // Start download with cookie file
    downloadVideoWithCookieFile(url, quality, downloadId).catch(err => {
      console.error('Download error:', err);
      downloadStatus.set(downloadId, { 
        status: 'error', 
        error: err.message
      });
    });
    
    res.json({ 
      success: true, 
      downloadId,
      message: 'Download started with enhanced bot evasion'
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

// Enhanced command generation with bot detection workarounds
app.post('/api/command', (req, res) => {
  try {
    const { url, quality } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }
    
    let baseCommand = 'yt-dlp ';
    
    if (quality === 'audio') {
      baseCommand += '--extract-audio --audio-format mp3 ';
    } else if (quality !== 'best') {
      baseCommand += `-f "${quality}" `;
    }
    
    baseCommand += '--output "%(title)s.%(ext)s" ';
    baseCommand += `"${url}"`;
    
    const commands = {
      basic: baseCommand,
      withBrowserCookies: baseCommand.replace('yt-dlp ', 'yt-dlp --cookies-from-browser chrome '),
      withFirefoxCookies: baseCommand.replace('yt-dlp ', 'yt-dlp --cookies-from-browser firefox '),
      enhanced: baseCommand.replace('yt-dlp ', 'yt-dlp --cookies-from-browser chrome --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" --sleep-interval 3 --retries 5 '),
      androidClient: baseCommand.replace('yt-dlp ', 'yt-dlp --extractor-args "youtube:player_client=android" '),
      webEmbedded: baseCommand.replace('yt-dlp ', 'yt-dlp --extractor-args "youtube:player_client=web_embedded" --add-header "Referer:https://www.youtube.com/" ')
    };
    
    res.json({
      success: true,
      recommended: commands.withBrowserCookies,
      commands: commands,
      message: 'Multiple command options generated',
      instructions: [
        'If server downloads fail due to bot detection, use these manual commands:',
        '1. Try "withBrowserCookies" first (requires Chrome browser with YouTube login)',
        '2. If Chrome cookies fail, try "withFirefoxCookies"',
        '3. For stubborn videos, use "enhanced" with delays',
        '4. For age-restricted content, try "androidClient"'
      ],
      troubleshooting: {
        bot_detection: 'YouTube detected server as bot - manual download required',
        solution: 'Use command with --cookies-from-browser to authenticate with your browser cookies'
      }
    });
    
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Cleanup old downloads and cookie files
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
    
    // Clean old cookie file if expired
    if (Date.now() > cookieFileExpiry) {
      try {
        await fs.unlink(cookieFilePath);
        console.log('🧹 Cleaned expired cookie file');
      } catch (e) {
        // File may not exist
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
    
    // Initialize cookie file after yt-dlp is ready
    setTimeout(async () => {
      if (ytDlpAvailable) {
        console.log('🍪 Initializing YouTube cookie file...');
        await establishRealSessionFile();
        console.log('🎯 Enhanced cookie file authentication ready!');
      }
    }, 3000);
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
