"""
spaim_mail.py — S.N.E.T.C.H Spam Mail Checker (backend)

Classifies raw email/message text as SPAM or HAM (not spam) using a
pretrained Keras model + TF-IDF vectorizer + label encoder (trained
offline, shipped in models/spam_model.keras, models/tfidf.pkl,
models/label_encoder.pkl).

Heavy imports (tensorflow, nltk, emoji, bs4) are done lazily — only
when check_email() is actually called — so importing this module at
app.py startup stays fast.

Public function used by app.py:
    check_email(text) -> dict
"""

import os
import re
import string

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
from model_loader import ensure_model

MODEL_PATH = os.path.join(BASE_DIR, "models", "spam_model.keras")
TFIDF_PATH = os.path.join(BASE_DIR, "models", "tfidf.pkl")
ENCODER_PATH = os.path.join(BASE_DIR, "models", "label_encoder.pkl")

ensure_model(MODEL_PATH, "12OeC2i729uX5G2lNW7q68DR04kceq48C")
ensure_model(TFIDF_PATH, "1VU3QrgDFihRThX0Qd7Uaf9TkBQUe7Ouj")
ensure_model(ENCODER_PATH, "1BvX85cJDXw-dUjfozI1vvOQM6jLLPvhA")

# Lazy-loaded singletons so the model/NLTK data are only loaded once,
# on first use, and reused for every request after that.
_model = None
_tfidf = None
_label_encoder = None
_lemmatizer = None
_stop_words = None
_nltk_ready = False


class SpamCheckError(Exception):
    """Raised when the classifier artifacts can't be loaded."""


def _ensure_nltk():
    """Download required NLTK corpora once (quiet, no-op if already present)."""
    global _nltk_ready, _lemmatizer, _stop_words
    if _nltk_ready:
        return

    import nltk
    from nltk.corpus import stopwords
    from nltk.stem import WordNetLemmatizer

    for pkg in ("punkt", "punkt_tab", "stopwords", "wordnet", "omw-1.4"):
        try:
            nltk.data.find(f"tokenizers/{pkg}" if "punkt" in pkg else f"corpora/{pkg}")
        except LookupError:
            nltk.download(pkg, quiet=True)

    _stop_words = set(stopwords.words("english"))
    _lemmatizer = WordNetLemmatizer()
    _nltk_ready = True


def _load_artifacts():
    """Load the Keras model + TF-IDF vectorizer + label encoder (once)."""
    global _model, _tfidf, _label_encoder
    if _model is not None:
        return

    if not os.path.exists(MODEL_PATH):
        raise SpamCheckError("Spam model not found (models/spam_model.keras is missing).")
    if not os.path.exists(TFIDF_PATH) or not os.path.exists(ENCODER_PATH):
        raise SpamCheckError("Vectorizer/label encoder files are missing from models/.")

    import joblib
    from tensorflow.keras.models import load_model

    _model = load_model(MODEL_PATH)
    _tfidf = joblib.load(TFIDF_PATH)
    _label_encoder = joblib.load(ENCODER_PATH)


def preprocess(text):
    """Clean raw email text the same way the model was trained on."""
    from bs4 import BeautifulSoup
    import emoji
    from nltk.tokenize import word_tokenize

    _ensure_nltk()

    text = str(text).lower()
    text = BeautifulSoup(text, "html.parser").get_text()          # strip HTML
    text = re.sub(r"https?://\S+|www\.\S+", "", text)             # strip URLs
    text = re.sub(r"\S+@\S+", "", text)                           # strip emails
    text = emoji.replace_emoji(text, replace="")                  # strip emoji
    text = re.sub(r"\d+", "", text)                               # strip numbers
    text = text.translate(str.maketrans("", "", string.punctuation))  # strip punctuation
    text = re.sub(r"[^a-zA-Z\s]", "", text)                       # strip special chars
    text = re.sub(r"\s+", " ", text).strip()                      # collapse spaces

    words = word_tokenize(text)
    words = [w for w in words if w not in _stop_words]
    words = [_lemmatizer.lemmatize(w) for w in words]
    return " ".join(words)


def check_email(text):
    """
    Classify a raw email/message string.

    Returns on success:
        {
          "success": True,
          "label": "spam" | "ham",
          "is_spam": bool,
          "confidence": float,        # 0-1, confidence in the predicted label
          "spam_probability": float,  # 0-1, raw model output
        }
    Returns on failure:
        { "success": False, "error": "<message>" }
    """
    text = (text or "").strip()
    if not text:
        return {"success": False, "error": "Please paste an email or message first."}
    if len(text) > 20000:
        return {"success": False, "error": "That's too long — please paste under 20,000 characters."}

    try:
        _load_artifacts()
        cleaned = preprocess(text)
        if not cleaned:
            return {"success": False, "error": "Couldn't extract any readable words from that text."}

        vector = _tfidf.transform([cleaned]).toarray()
        raw_prob = float(_model.predict(vector, verbose=0)[0][0])
        predicted = int(raw_prob > 0.5)
        label = str(_label_encoder.inverse_transform([predicted])[0])
        confidence = raw_prob if predicted == 1 else (1 - raw_prob)

        return {
            "success": True,
            "label": label,
            "is_spam": label == "spam",
            "confidence": round(confidence, 4),
            "spam_probability": round(raw_prob, 4),
        }
    except SpamCheckError as exc:
        return {"success": False, "error": str(exc)}
    except Exception as exc:  # model/runtime errors shouldn't crash the request
        return {"success": False, "error": f"Classifier error: {exc}"}