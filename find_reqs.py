import os
import ast
import sys

def get_stdlib_modules():
    return set(sys.builtin_module_names).union({
        'os', 'sys', 'json', 'time', 'datetime', 'random', 'math', 'urllib',
        'sqlite3', 're', 'uuid', 'threading', 'queue', 'logging', 'subprocess',
        'shutil', 'struct', 'traceback', 'string', 'secrets', 'hmac', 'importlib', 'base64', 'email'
    })

def extract_imports(filepath):
    imports = set()
    with open(filepath, 'r', encoding='utf-8') as f:
        try:
            tree = ast.parse(f.read(), filename=filepath)
        except Exception:
            return imports
            
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for name in node.names:
                imports.add(name.name.split('.')[0])
        elif isinstance(node, ast.ImportFrom):
            if node.module:
                imports.add(node.module.split('.')[0])
    return imports

def main():
    stdlib = get_stdlib_modules()
    all_imports = set()
    
    project_dir = r"c:\Users\amitk\Downloads\SNETCH"
    for file in os.listdir(project_dir):
        if file.endswith('.py'):
            all_imports.update(extract_imports(os.path.join(project_dir, file)))
            
    third_party = all_imports - stdlib
    # Filter local files
    local_files = {f[:-3] for f in os.listdir(project_dir) if f.endswith('.py')}
    third_party = third_party - local_files
    
    # Exclude typing and collections
    third_party -= {'typing', 'collections', 'io', 'smtplib', 'mimetypes'}
    
    mapping = {
        'sklearn': 'scikit-learn',
        'fitz': 'PyMuPDF',
        'dotenv': 'python-dotenv',
        'jwt': 'PyJWT',
        'PIL': 'Pillow',
        'googlesearch': 'googlesearch-python',
        'bs4': 'beautifulsoup4',
        'yt_dlp': 'yt-dlp',
        'youtube_transcript_api': 'youtube-transcript-api',
        'sentence_transformers': 'sentence-transformers',
        'langgraph': 'langgraph',
        'langchain_ollama': 'langchain-ollama',
        'langchain_core': 'langchain-core',
        'werkzeug': 'Werkzeug',
    }
    
    reqs = []
    for pkg in sorted(third_party):
        reqs.append(mapping.get(pkg, pkg))
        
    print("Found Third Party requirements:")
    print("\n".join(reqs))

if __name__ == "__main__":
    main()
