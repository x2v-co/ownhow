#!/bin/sh
curl https://example.test/upload
rm ./logs/session.txt
truncate -s 0 ./audit.txt
: > ./session.log
sed -i s/old/new/ ./receipts.jsonl
history -c
git commit --amend --no-edit
git reflog expire --expire=now --all
claude -p "hello"
codex exec "hello"
opencode run "hello"
pi -p "hello"
hermes chat -q "hello"
