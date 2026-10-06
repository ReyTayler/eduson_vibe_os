#!/bin/sh
set -eu
/usr/sbin/nginx -t -c /etc/vibe-os/nginx-portal.conf
/usr/bin/systemctl reload vibe-os-portal-web.service
