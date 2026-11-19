"""Stage the validated Pages artifact as the personal site's blog tree."""

import argparse
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tarfile
from tempfile import TemporaryDirectory


def git(checkout, *args):
    return subprocess.check_output(["git", "-C", checkout, *args])


def extract_pages(artifact, output, checkout):
    expected = {}
    with tarfile.open(artifact, "r:") as archive:
        for entry in archive:
            path = PurePosixPath(entry.name)
            if path.is_absolute() or any(
                part == ".." or part.casefold() == ".git" for part in path.parts
            ):
                raise ValueError(f"Invalid Pages artifact path: {entry.name!r}")

            destination = output.joinpath(*path.parts)
            if entry.isdir():
                destination.mkdir(parents=True, exist_ok=True)
                continue
            if not entry.isfile() or not path.parts:
                raise ValueError(f"Expected a regular Pages file: {entry.name!r}")

            destination.parent.mkdir(parents=True, exist_ok=True)
            with archive.extractfile(entry) as source, destination.open("xb") as file:
                shutil.copyfileobj(source, file)
            blob = git(checkout, "hash-object", "--no-filters", "--", destination).strip()
            expected[f"blog/{path}".encode("utf-8", "surrogateescape")] = blob

    if not {b"blog/index.html", b"blog/rss.xml"}.issubset(expected):
        raise ValueError("Pages artifact must include index.html and rss.xml")
    return expected


def stage_pages(artifact, checkout):
    if Path(git(checkout, "rev-parse", "--show-toplevel").decode().strip()) != checkout:
        raise ValueError("Expected the personal Pages checkout root")
    if git(checkout, "diff", "--cached", "--name-only", "-z"):
        raise ValueError("Expected an empty staging area")
    nojekyll = checkout / ".nojekyll"
    if not nojekyll.is_file() or nojekyll.is_symlink():
        raise ValueError("Personal Pages checkout must have a root .nojekyll file")
    git(checkout, "ls-files", "--error-unmatch", "--", ".nojekyll")

    blog = checkout / "blog"
    with TemporaryDirectory(dir=checkout.parent) as temporary:
        output = Path(temporary) / "blog"
        output.mkdir()
        expected = extract_pages(artifact, output, checkout)
        if blog.is_symlink():
            raise ValueError("Expected blog to be a directory")
        if blog.exists():
            shutil.rmtree(blog)
        output.rename(blog)

    git(checkout, "add", "--force", "--all", "--", "blog")
    staged = {}
    for record in git(checkout, "ls-files", "--stage", "-z", "--", "blog").split(b"\0"):
        if not record:
            continue
        metadata, path = record.split(b"\t", 1)
        mode, blob, stage = metadata.split()
        if mode != b"100644" or stage != b"0":
            raise ValueError(f"Expected a regular staged Pages file: {path!r}")
        staged[path] = blob
    if staged != expected:
        raise ValueError("Staged blog paths or file bytes differ from the Pages artifact")

    print(f"Verified {len(staged)} staged files against the Pages artifact")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("artifact", type=Path)
    parser.add_argument("checkout", type=Path)
    args = parser.parse_args()
    try:
        stage_pages(args.artifact, args.checkout.resolve())
    except (OSError, ValueError, tarfile.TarError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"{error}\n")
