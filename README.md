# YouTube Direct Downloader

🎬 A modern, mobile-optimized YouTube downloader that runs yt-dlp on the server and streams downloads directly to your device.

## ✨ Features

- 🚀 **Direct Downloads** - No software installation required
- 📱 **Mobile Optimized** - Perfect for smartphones and tablets  
- 🎯 **Multiple Qualities** - Best, 720p, 480p, and audio-only
- ⚡ **Real-time Progress** - Live download progress tracking
- 🔄 **Auto Video Info** - Fetches title, duration, and uploader
- 🎨 **Modern UI** - Beautiful, responsive design
- 🧹 **Auto Cleanup** - Temporary files are automatically removed

## 🚀 Quick Start

### Local Development

1. **Clone and setup:**
   ```bash
   git clone <your-repo-url>
   cd youtube-direct-downloader
   npm install
   ```

2. **Install yt-dlp:**
   ```bash
   pip install yt-dlp
   ```

3. **Start the server:**
   ```bash
   npm start
   ```

4. **Open browser:**
   ```
   http://localhost:3000
   ```

### Usage

1. **Paste YouTube URL** - The app will automatically fetch video info
2. **Select Quality** - Choose from Best, 720p, 480p, or Audio Only
3. **Click Download** - Watch real-time progress
4. **Download File** - Click the download link when ready

## 🌐 Deployment

### Deploy to Render

1. **Push to GitHub**
2. **Connect to Render:**
   - New Web Service
   - Connect GitHub repository
   - Build Command: `npm install`
   - Start Command: `npm start`

### Deploy to Other Platforms

- **Vercel:** `vercel --prod`
- **Railway:** Connect GitHub repo
- **Heroku:** `git push heroku main`

## 📚 API Endpoints

- `POST /api/info` - Get video information
- `POST /api/download` - Start download
- `GET /api/status/:id` - Check download progress
- `GET /api/file/:id` - Download completed file

## ⚙️ Configuration

### Environment Variables

- `PORT` - Server port (default: 3000)
- `NODE_ENV` - Environment (production/development)

### Server Limits

- **File cleanup** - Files auto-delete after 1 hour
- **Temp storage** - Uses `/tmp/downloads` directory
- **Memory usage** - Optimized for server resources

## 🔧 Technical Details

### Dependencies

- **Express.js** - Web server framework
- **yt-dlp** - YouTube download engine
- **Helmet** - Security headers
- **Compression** - Response compression
- **UUID** - Unique download IDs

### Browser Support

- Chrome/Safari (iOS/Android)
- Firefox Mobile
- Samsung Internet
- Any modern mobile browser

## 📱 Mobile Features

- **Touch optimized** - Large tap targets
- **Auto-paste detection** - Detects YouTube URLs in clipboard
- **Progressive Web App** - Can be installed as app
- **Responsive design** - Works on all screen sizes

## ⚠️ Important Notes

### Hosting Considerations

- **Free tiers** may have resource limits
- **Large files** may require upgraded hosting
- **yt-dlp updates** happen automatically on restart

### Legal Compliance

- Respect YouTube's Terms of Service
- Only download content you have rights to
- Use responsibly and ethically

## 🤝 Contributing

1. Fork the repository
2. Create feature branch: `git checkout -b feature-name`
3. Commit changes: `git commit -am 'Add feature'`
4. Push to branch: `git push origin feature-name`
5. Submit pull request

## 📄 License

MIT License - see LICENSE file for details

## 🆘 Support

- **Issues**: Create GitHub issue
- **Questions**: Check existing issues first
- **Updates**: Watch repository for updates

---

Made with ❤️ for easy YouTube downloading
