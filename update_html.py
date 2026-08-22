import os
import re

TEMPLATES_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'templates')

HEAD_TAGS = """
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"/>
  <meta name="theme-color" content="#020810"/>
  <meta name="apple-mobile-web-app-capable" content="yes"/>
  <link rel="manifest" href="/manifest.json"/>
"""

RESPONSIVE_CSS = """<link rel="stylesheet" href="/static/responsive.css"/>"""

SW_SCRIPT = """
<!-- PWA Service Worker Registration -->
<script>
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').then(reg => {
        console.log('SW registered: ', reg.scope);
      }).catch(err => {
        console.log('SW registration failed: ', err);
      });
    });
  }
</script>
"""

def update_file(filepath):
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    # 1. Remove existing viewport, theme-color, manifest to avoid duplicates
    content = re.sub(r'<meta[^>]*name=["\']viewport["\'][^>]*>', '', content, flags=re.IGNORECASE)
    content = re.sub(r'<meta[^>]*name=["\']theme-color["\'][^>]*>', '', content, flags=re.IGNORECASE)
    content = re.sub(r'<meta[^>]*name=["\']apple-mobile-web-app-capable["\'][^>]*>', '', content, flags=re.IGNORECASE)
    content = re.sub(r'<link[^>]*rel=["\']manifest["\'][^>]*>', '', content, flags=re.IGNORECASE)
    
    # 2. Add HEAD_TAGS right after <head>
    if '<head>' in content:
        content = content.replace('<head>', '<head>\n' + HEAD_TAGS)
    elif '<head ' in content:
        # Match <head ...>
        content = re.sub(r'(<head[^>]*>)', r'\1\n' + HEAD_TAGS, content, count=1, flags=re.IGNORECASE)
        
    # 3. Add responsive.css if not present
    if 'responsive.css' not in content:
        if '</head>' in content:
            content = content.replace('</head>', '  ' + RESPONSIVE_CSS + '\n</head>')
            
    # 4. Add SW script before </body> if not present
    if '/sw.js' not in content and 'serviceWorker' not in content:
        if '</body>' in content:
            content = content.replace('</body>', SW_SCRIPT + '\n</body>')

    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)
    print(f"Updated: {filepath}")

if __name__ == "__main__":
    for filename in os.listdir(TEMPLATES_DIR):
        if filename.endswith(".html"):
            filepath = os.path.join(TEMPLATES_DIR, filename)
            update_file(filepath)
    print("All HTML files updated successfully.")
