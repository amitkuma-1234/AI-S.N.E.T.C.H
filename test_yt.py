import sys
sys.path.append('.')
from downloadvideo import extract_metadata
try:
    print(extract_metadata('https://www.youtube.com/watch?v=d7Z8gpJSITM'))
except Exception as e:
    import traceback
    traceback.print_exc()
