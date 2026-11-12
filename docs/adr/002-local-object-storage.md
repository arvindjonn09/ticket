# Local S3 storage

10 November 2026: the original plan specified MinIO for local development. Pulling `minio/minio:latest` failed with repository unavailable, and `quay.io/minio/minio:latest` returned HTTP 401. The local Compose service therefore uses RustFS with the existing S3-compatible API boundary. This is an infrastructure substitution, not an application storage protocol change.

The [official RustFS repository](https://github.com/rustfs/rustfs) identifies its S3 compatibility and Apache-2.0 licence; [Docker instructions](https://docs.rustfs.com/en/installation/container/docker) document the image and configuration. Local storage is private, credentials stay server-side, and only the API serves authenticated downloads after ClamAV scanning. Production object storage remains a deployment choice.

ClamAV is a separate GPL service and needs the planned distribution/licensing review before commercial bundling. Local image versions/digests are recorded during verification rather than assumed to represent a production support commitment.
