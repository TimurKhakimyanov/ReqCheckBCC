"""Объектное хранилище через S3 API (SeaweedFS; заменяемо на любое S3-совместимое)."""

from __future__ import annotations

import logging
import threading
from collections.abc import Iterator
from pathlib import Path
from typing import Protocol

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

log = logging.getLogger(__name__)


class ObjectStore(Protocol):
    def ensure_bucket(self) -> None: ...
    def put(self, key: str, data: bytes, content_type: str = "application/octet-stream") -> None: ...
    def get(self, key: str) -> bytes: ...
    def iter_chunks(self, key: str, chunk_size: int = 1 << 16) -> Iterator[bytes]: ...
    def download_to(self, key: str, path: Path) -> None: ...
    def exists(self, key: str) -> bool: ...
    def delete_prefix(self, prefix: str) -> None: ...
    def ping(self) -> None: ...


class S3ObjectStore:
    def __init__(self, endpoint_url: str, access_key: str, secret_key: str, bucket: str, region: str = "us-east-1"):
        self.bucket = bucket
        self.client = boto3.client(
            "s3",
            endpoint_url=endpoint_url,
            aws_access_key_id=access_key or None,
            aws_secret_access_key=secret_key or None,
            region_name=region,
            config=Config(s3={"addressing_style": "path"}, retries={"max_attempts": 3}, connect_timeout=5,
                          read_timeout=60, signature_version="s3v4"),
        )
        self._bucket_ready = False
        self._lock = threading.Lock()

    def ensure_bucket(self) -> None:
        if self._bucket_ready:
            return
        with self._lock:
            try:
                self.client.head_bucket(Bucket=self.bucket)
            except ClientError:
                self.client.create_bucket(Bucket=self.bucket)
                log.info("created bucket", extra={"bucket": self.bucket})
            self._bucket_ready = True

    def put(self, key: str, data: bytes, content_type: str = "application/octet-stream") -> None:
        self.ensure_bucket()
        self.client.put_object(Bucket=self.bucket, Key=key, Body=data, ContentType=content_type)

    def get(self, key: str) -> bytes:
        return self.client.get_object(Bucket=self.bucket, Key=key)["Body"].read()

    def iter_chunks(self, key: str, chunk_size: int = 1 << 16) -> Iterator[bytes]:
        body = self.client.get_object(Bucket=self.bucket, Key=key)["Body"]
        yield from body.iter_chunks(chunk_size)

    def download_to(self, key: str, path: Path) -> None:
        self.client.download_file(self.bucket, key, str(path))

    def exists(self, key: str) -> bool:
        try:
            self.client.head_object(Bucket=self.bucket, Key=key)
            return True
        except ClientError:
            return False

    def delete_prefix(self, prefix: str) -> None:
        paginator = self.client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self.bucket, Prefix=prefix):
            keys = [{"Key": o["Key"]} for o in page.get("Contents", [])]
            if keys:
                self.client.delete_objects(Bucket=self.bucket, Delete={"Objects": keys})

    def ping(self) -> None:
        self.ensure_bucket()


class MemoryObjectStore:
    """Хранилище в памяти — для тестов."""

    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}

    def ensure_bucket(self) -> None:
        pass

    def put(self, key: str, data: bytes, content_type: str = "application/octet-stream") -> None:
        self.objects[key] = data

    def get(self, key: str) -> bytes:
        return self.objects[key]

    def iter_chunks(self, key: str, chunk_size: int = 1 << 16) -> Iterator[bytes]:
        data = self.objects[key]
        for i in range(0, len(data), chunk_size):
            yield data[i : i + chunk_size]

    def download_to(self, key: str, path: Path) -> None:
        path.write_bytes(self.objects[key])

    def exists(self, key: str) -> bool:
        return key in self.objects

    def delete_prefix(self, prefix: str) -> None:
        for key in [k for k in self.objects if k.startswith(prefix)]:
            del self.objects[key]

    def ping(self) -> None:
        pass
