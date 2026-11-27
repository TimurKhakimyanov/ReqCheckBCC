"""Генерация ключей для .env: python -m app.keygen"""

import secrets

from cryptography.fernet import Fernet

if __name__ == "__main__":
    print(f"APP_ENCRYPTION_KEY={Fernet.generate_key().decode()}")
    print(f"APP_SECRET_KEY={secrets.token_urlsafe(48)}")
