#!/usr/bin/env python3
"""Builds a container image without Docker: a pinned base image plus layers made from local folders, pushed to the
Cloudflare registry. build-images.sh calls it once per image; the Dockerfiles in infra/ stay the specification of
what each image holds, and this reproduces their final stage (the Mac has no Docker, and the GitHub-hosted runner
that used to run `docker build` is no longer relied on).

    build-image.py --base docker.io/library/node@sha256:... --dest registry.cloudflare.com/<account>/jstar-api:<tag>
                   --layer <folder> [--layer <folder> ...] [--workdir /srv] [--user node] [--env K=V ...]
                   [--expose 8080] [--cmd '["node","server.mjs"]'] [--label k=v ...] [--created <ISO time>]

Each --layer folder is laid over / as it is (folder/srv/server.mjs becomes /srv/server.mjs). Files are written with
owner root:root, mode 0644 (0755 for folders and executables) and a fixed time, so the same folder always gives the
same layer digest. The registry password is read from REGISTRY_PASSWORD (user "v1", from `wrangler containers
registries credentials registry.cloudflare.com --push --pull`). Only the Python standard library is used.
"""
import argparse
import gzip
import hashlib
import io
import json
import os
import sys
import tarfile
import tempfile
import urllib.error
import urllib.request
from base64 import b64encode

OCI_INDEX = "application/vnd.oci.image.index.v1+json"
DOCKER_LIST = "application/vnd.docker.distribution.manifest.list.v2+json"
OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json"
DOCKER_MANIFEST = "application/vnd.docker.distribution.manifest.v2+json"
ACCEPT = ", ".join([OCI_MANIFEST, DOCKER_MANIFEST, OCI_INDEX, DOCKER_LIST])


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def request(url, headers=None, method="GET", data=None):
    req = urllib.request.Request(url, headers=headers or {}, method=method, data=data)
    return urllib.request.urlopen(req, timeout=600)


class Registry:
    """The v2 API of one registry: anonymous bearer tokens (Docker Hub) or basic auth (Cloudflare)."""

    def __init__(self, host, basic=None):
        self.host = host
        self.basic = basic
        self.tokens = {}

    def auth(self, repo):
        if self.basic:
            return {"Authorization": "Basic " + b64encode(self.basic.encode()).decode()}
        if repo not in self.tokens:
            url = "https://auth.docker.io/token?service=registry.docker.io&scope=repository:%s:pull" % repo
            self.tokens[repo] = json.load(request(url))["token"]
        return {"Authorization": "Bearer " + self.tokens[repo]}

    def base(self):
        return "https://" + ("registry-1.docker.io" if self.host == "docker.io" else self.host)

    def get(self, repo, path, accept=None):
        headers = dict(self.auth(repo))
        if accept:
            headers["Accept"] = accept
        return request("%s/v2/%s/%s" % (self.base(), repo, path), headers)

    def has_blob(self, repo, digest):
        try:
            request("%s/v2/%s/blobs/%s" % (self.base(), repo, digest), self.auth(repo), method="HEAD")
            return True
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return False
            raise

    def put_blob(self, repo, digest, path):
        if self.has_blob(repo, digest):
            return False
        r = request("%s/v2/%s/blobs/uploads/" % (self.base(), repo), self.auth(repo), method="POST", data=b"")
        location = r.headers["Location"]
        if not location.startswith("http"):
            location = self.base() + location
        sep = "&" if "?" in location else "?"
        with open(path, "rb") as f:
            body = f.read()
        headers = dict(self.auth(repo))
        headers["Content-Type"] = "application/octet-stream"
        request(location + sep + "digest=" + digest, headers, method="PUT", data=body)
        return True

    def put_manifest(self, repo, ref, media_type, body):
        headers = dict(self.auth(repo))
        headers["Content-Type"] = media_type
        r = request("%s/v2/%s/manifests/%s" % (self.base(), repo, ref), headers, method="PUT", data=body)
        return r.headers.get("Docker-Content-Digest", "")


def split_ref(ref):
    """registry.cloudflare.com/acct/jstar-api:tag -> (host, repo, reference)."""
    host, _, rest = ref.partition("/")
    if "@" in rest:
        repo, _, reference = rest.partition("@")
    else:
        repo, _, reference = rest.rpartition(":")
    return host, repo, reference


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return "sha256:" + h.hexdigest()


def make_layer(folder, mtime, workdir):
    """A reproducible tar.gz of `folder` laid over /: (gz path, digest, diff_id, size)."""
    raw = tempfile.NamedTemporaryFile(delete=False, suffix=".tar")
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.PAX_FORMAT) as tar:
        entries = []
        for root, dirs, files in os.walk(folder):
            dirs.sort()
            for name in sorted(dirs) + sorted(files):
                entries.append(os.path.join(root, name))
        for path in sorted(entries):
            rel = os.path.relpath(path, folder)
            info = tar.gettarinfo(path, arcname=rel)
            info.uid = info.gid = 0
            info.uname = info.gname = "root"
            info.mtime = mtime
            if info.isdir():
                info.mode = 0o755
                tar.addfile(info)
            elif info.issym():
                tar.addfile(info)
            else:
                info.mode = 0o755 if os.access(path, os.X_OK) else 0o644
                with open(path, "rb") as f:
                    tar.addfile(info, f)
    raw.close()
    diff_id = sha256_file(raw.name)
    gz = raw.name + ".gz"
    with open(raw.name, "rb") as src, open(gz, "wb") as out:
        with gzip.GzipFile(filename="", mode="wb", fileobj=out, mtime=0, compresslevel=6) as z:
            for chunk in iter(lambda: src.read(1 << 20), b""):
                z.write(chunk)
    os.unlink(raw.name)
    return gz, sha256_file(gz), diff_id, os.path.getsize(gz)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True, help="base image by digest, e.g. docker.io/library/node@sha256:...")
    ap.add_argument("--dest", required=True, help="registry.cloudflare.com/<account>/<name>:<tag>")
    ap.add_argument("--layer", action="append", default=[])
    ap.add_argument("--workdir")
    ap.add_argument("--user")
    ap.add_argument("--env", action="append", default=[])
    ap.add_argument("--expose", action="append", default=[])
    ap.add_argument("--cmd")
    ap.add_argument("--label", action="append", default=[])
    ap.add_argument("--created", default="1970-01-01T00:00:00Z")
    ap.add_argument("--mtime", type=int, default=0, help="file time inside the new layers (seconds)")
    ap.add_argument("--dry", action="store_true", help="build the layers and config, push nothing")
    a = ap.parse_args()

    bhost, brepo, bref = split_ref(a.base)
    if not bref.startswith("sha256:"):
        sys.exit("--base must be pinned by digest")
    src = Registry(bhost)
    manifest = json.load(src.get(brepo, "manifests/" + bref, ACCEPT))
    if manifest.get("mediaType") in (OCI_INDEX, DOCKER_LIST) or "manifests" in manifest:
        sys.exit("--base must name a single-platform manifest (linux/amd64), not an index")
    media_type = manifest.get("mediaType", OCI_MANIFEST)
    config = json.load(src.get(brepo, "blobs/" + manifest["config"]["digest"]))
    if (config.get("os"), config.get("architecture")) != ("linux", "amd64"):
        sys.exit("base is %s/%s, not linux/amd64" % (config.get("os"), config.get("architecture")))

    layer_type = "application/vnd.oci.image.layer.v1.tar+gzip" if media_type == OCI_MANIFEST else "application/vnd.docker.image.rootfs.diff.tar.gzip"
    config_type = "application/vnd.oci.image.config.v1+json" if media_type == OCI_MANIFEST else "application/vnd.docker.container.image.v1+json"

    new_layers = []
    for folder in a.layer:
        gz, digest, diff_id, size = make_layer(folder, a.mtime, a.workdir)
        log("layer %s: %s (%d bytes)" % (folder, digest, size))
        new_layers.append((gz, digest, diff_id, size, folder))

    c = config.setdefault("config", {})
    env = list(c.get("Env") or [])
    for kv in a.env:
        key = kv.split("=", 1)[0]
        env = [e for e in env if e.split("=", 1)[0] != key] + [kv]
    c["Env"] = env
    if a.workdir:
        c["WorkingDir"] = a.workdir
    if a.user:
        c["User"] = a.user
    if a.cmd:
        c["Cmd"] = json.loads(a.cmd)
    if a.expose:
        c["ExposedPorts"] = {(p if "/" in p else p + "/tcp"): {} for p in a.expose}
    if a.label:
        labels = dict(c.get("Labels") or {})
        for kv in a.label:
            k, _, v = kv.partition("=")
            labels[k] = v
        c["Labels"] = labels
    config["created"] = a.created
    config["rootfs"]["diff_ids"] = list(config["rootfs"]["diff_ids"]) + [l[2] for l in new_layers]
    history = list(config.get("history") or [])
    for l in new_layers:
        history.append({"created": a.created, "created_by": "build-image.py --layer %s" % os.path.basename(l[4].rstrip("/"))})
    config["history"] = history
    config_bytes = json.dumps(config, separators=(",", ":"), sort_keys=True).encode()
    config_digest = "sha256:" + hashlib.sha256(config_bytes).hexdigest()

    out = {
        "schemaVersion": 2,
        "mediaType": media_type,
        "config": {"mediaType": config_type, "digest": config_digest, "size": len(config_bytes)},
        "layers": list(manifest["layers"]) + [{"mediaType": layer_type, "digest": l[1], "size": l[3]} for l in new_layers],
    }
    manifest_bytes = json.dumps(out, separators=(",", ":")).encode()
    log("config %s, manifest %s" % (config_digest, "sha256:" + hashlib.sha256(manifest_bytes).hexdigest()))
    if a.dry:
        print(json.dumps({"config": config, "manifest": out}, indent=2))
        return

    dhost, drepo, dtag = split_ref(a.dest)
    password = os.environ.get("REGISTRY_PASSWORD")
    if not password:
        sys.exit("REGISTRY_PASSWORD is not set")
    dst = Registry(dhost, basic="v1:" + password)
    for layer in manifest["layers"]:
        if dst.has_blob(drepo, layer["digest"]):
            continue
        tmp = tempfile.NamedTemporaryFile(delete=False)
        with src.get(brepo, "blobs/" + layer["digest"]) as r:
            for chunk in iter(lambda: r.read(1 << 20), b""):
                tmp.write(chunk)
        tmp.close()
        if sha256_file(tmp.name) != layer["digest"]:
            sys.exit("base layer %s did not match its digest" % layer["digest"])
        dst.put_blob(drepo, layer["digest"], tmp.name)
        os.unlink(tmp.name)
        log("copied base layer %s" % layer["digest"])
    for gz, digest, _, _, _ in new_layers:
        dst.put_blob(drepo, digest, gz)
        os.unlink(gz)
    cfg = tempfile.NamedTemporaryFile(delete=False)
    cfg.write(config_bytes)
    cfg.close()
    dst.put_blob(drepo, config_digest, cfg.name)
    os.unlink(cfg.name)
    digest = dst.put_manifest(drepo, dtag, media_type, manifest_bytes)
    print("%s/%s:%s@%s" % (dhost, drepo, dtag, digest))


if __name__ == "__main__":
    main()
