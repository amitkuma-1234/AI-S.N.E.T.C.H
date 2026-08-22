# S.N.E.T.C.H
**Smart Neural Engine Tech Command Hub**

S.N.E.T.C.H is a powerful, futuristic, AI-driven Operating System built on the web. Designed to be your ultimate all-in-one digital assistant and workspace, it features 31 built-in productivity modules, deep AI integration, and a stunning 60FPS UI.

Fully responsive and built as a Progressive Web App (PWA), S.N.E.T.C.H flawlessly adapts to your Desktop, Laptop, Tablet, Android, and iPhone—providing a native app experience on any device.

---

## 🌟 Key Features

*   **Progressive Web App (PWA)**: Installable natively on iOS, Android, and Desktop with offline caching and background service workers.
*   **31 Integrated Modules**: Includes Smart Alarm, File Manager, AI Image Generator, YouTube AI Chatbot, Password Vault (SnapLock), Document AI, WhatsApp Messenger, World Clock, Web Search, and more.
*   **Universal Responsive UI**: A premium, glass-morphic, dark-mode design language that scales beautifully without breaking, whether you are on a 4K monitor or an iPhone.
*   **60FPS Animations**: Hardware-accelerated CSS and optimized rendering ensure a buttery-smooth experience across the entire neural interface.
*   **Centralized Flask Backend**: One unified Python codebase powering everything securely via robust API routes.
*   **Secure Authentication**: JWT-based session management handling both Email/Password and Google OAuth logins.

---

## 🚀 Installation & Setup

1. **Clone or Extract the Repository:**
   Ensure you have all the project files in a single directory.

2. **Install Dependencies:**
   Make sure you have Python 3.9+ installed. Run the following command in your terminal:
   ```bash
   pip install -r requirements.txt
   ```

3. **Environment Variables:**
   Ensure you have a `.env` file in the root directory containing your necessary API keys and secrets:
   ```env
   SECRET_KEY=your_secret_key
   GOOGLE_CLIENT_ID=your_google_id
   GOOGLE_CLIENT_SECRET=your_google_secret
   # Add your AI and API keys for the specific features
   ```

4. **Run the Server:**
   Start the Flask application:
   ```bash
   python app.py
   ```

5. **Access the Application:**
   Open your browser and navigate to:
   ```
   http://127.0.0.1:5000/login
   ```

---

## 📱 Mobile Installation (PWA)

To install S.N.E.T.C.H as a native mobile app:
1. Open the application URL in **Chrome** (Android) or **Safari** (iPhone).
2. Tap the browser's menu button (three dots in Chrome, or the Share button in Safari).
3. Select **"Add to Home Screen"**.
4. The S.N.E.T.C.H icon will now appear on your home screen. Launch it directly for a full-screen, immersive OS experience!

---

## 🏗️ Architecture overview

*   **`app.py`**: The core Flask server, router, and authentication handler.
*   **`templates/`**: Contains all 37 HTML pages, fully optimized with PWA meta tags and viewport rules.
*   **`static/`**: Houses global CSS (`responsive.css`), Service Worker (`sw.js`), Web Manifest (`manifest.json`), and individual module stylesheets.
*   **`js/`**: Contains all modular JavaScript logic for UI interactions, sidebar drawer behaviors, and API calls.
*   **Python Modules (`*.py`)**: Each of the 31 features is compartmentalized into its own backend Python script, keeping the architecture clean and scalable.

---

*Built with ❤️ in SNETCH Labs.*
