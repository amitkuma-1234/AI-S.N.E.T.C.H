import os
import gdown

def ensure_model(local_path: str, gdrive_file_id: str):
    """Download from Google Drive only if not already present locally."""
    if os.path.exists(local_path):
        return local_path
    os.makedirs(os.path.dirname(local_path), exist_ok=True)
    url = f"https://drive.google.com/uc?id={gdrive_file_id}"
    gdown.download(url, local_path, quiet=False)
    return local_path