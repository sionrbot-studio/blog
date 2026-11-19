"""Make read-only OCI manifests from the pinned official Playwright amd64 layers."""

import base64
import hashlib
import json
import sys
from urllib.request import Request, urlopen

REGISTRY = "https://mcr.microsoft.com/v2/playwright"
MANIFEST_TYPE = "application/vnd.oci.image.manifest.v1+json"
CONFIG_TYPE = "application/vnd.oci.image.config.v1+json"
# This linux/amd64 manifest belongs to the v1.65.0-noble image index.
UPSTREAM = "sha256:f6fe3cf9a493670b9a20f33597a807262abb25c40c31839ba4ac1dbc51fe7366"
FIREFOX = "sha256:18563da2c18c2a000c16a386f81c5ac1ecbb2cd6ced5a760965ff97511a52092"
WEBKIT = "sha256:349f5ffaff07884d162fc813c5bef0b47bc722b7cdcae8661bb947d2aee48acd"


def digest(data):
    return "sha256:" + hashlib.sha256(data).hexdigest()


def pinned_json(path, expected):
    request = Request(f"{REGISTRY}/{path}/{expected}", headers={"Accept": MANIFEST_TYPE})
    with urlopen(request, timeout=10) as response:
        data = response.read()
    if digest(data) != expected:
        raise ValueError(f"Unexpected digest for {path}/{expected}")
    return json.loads(data)


def encode(value):
    return json.dumps(value, separators=(",", ":")).encode()


def profile(source, upstream_config, omit):
    layers = source["layers"]
    diff_ids = upstream_config["rootfs"]["diff_ids"]
    if len(layers) != len(diff_ids) or not omit.issubset({layer["digest"] for layer in layers}):
        raise ValueError("Layer selection does not match the pinned upstream image")

    selected = [i for i, layer in enumerate(layers) if layer["digest"] not in omit]
    config = encode({
        "architecture": upstream_config["architecture"],
        "os": upstream_config["os"],
        "config": upstream_config["config"],
        "rootfs": {"type": "layers", "diff_ids": [diff_ids[i] for i in selected]},
    })
    manifest = encode({
        "schemaVersion": 2,
        "mediaType": MANIFEST_TYPE,
        "config": {"mediaType": CONFIG_TYPE, "size": len(config), "digest": digest(config)},
        "layers": [layers[i] for i in selected],
    })

    # nginx serves the two small metadata objects on loopback. Docker retrieves
    # the actual compressed layers directly from MCR and checks their digests.
    locations = []
    for kind, mime, data in (("manifests", MANIFEST_TYPE, manifest), ("blobs", CONFIG_TYPE, config)):
        key = digest(data)
        # The immutable metadata payloads are emitted as literal nginx strings.
        value = data.decode()
        if any(c in value for c in ("'", "$", "\\")):
            raise ValueError("Unexpected character in OCI metadata")
        locations.append(f"""
        location = /v2/playwright/{kind}/{key} {{
            default_type {mime};
            add_header Docker-Content-Digest {key};
            return 200 '{value}';
        }}""")
    nginx = """
pid browser-image.pid;
error_log stderr;
events {}
http {
    access_log off;
    client_body_temp_path client_temp;
    proxy_temp_path proxy_temp;
    fastcgi_temp_path fastcgi_temp;
    uwsgi_temp_path uwsgi_temp;
    scgi_temp_path scgi_temp;
    server {
        listen 127.0.0.1:5099;
        location = /v2/ { return 200 '{}'; }
        location ~ ^/v2/playwright/blobs/(sha256:[0-9a-f]+)$ {
            return 307 https://mcr.microsoft.com/v2/playwright/blobs/$1;
        }
        """ + "".join(locations) + """
        location / { return 404; }
    }
}"""
    return {
        "image": "127.0.0.1:5099/playwright@" + digest(manifest),
        "nginx": base64.b64encode(nginx.encode()).decode(),
        "bytes": sum(layers[i]["size"] for i in selected),
    }


if __name__ == "__main__":
    source = pinned_json("manifests", UPSTREAM)
    config = pinned_json("blobs", source["config"]["digest"])
    if (config["architecture"], config["os"]) != ("amd64", "linux"):
        sys.exit("Expected linux/amd64 Playwright image")
    print(encode({
        "both": profile(source, config, {FIREFOX}),
        "chromium": profile(source, config, {FIREFOX, WEBKIT}),
    }).decode())
