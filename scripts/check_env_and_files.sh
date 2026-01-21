#!/bin/bash

# Load environment variables from .env file if it exists in the current directory
if [ -f .env ]; then
  export $(grep -v '^#' .env | xargs)
fi

# Check required environment variables
REQUIRED_VARS=("BLUESKY_USERNAME" "BLUESKY_PASSWORD" "TWITTER_HANDLES")
for VAR in "${REQUIRED_VARS[@]}"; do
  if [ -z "${!VAR}" ]; then
    echo "Error: $VAR is not set."
    exit 1
  fi
done

# Check if /twitter-data directory is not empty
if [ -z "$(ls -A /twitter-data)" ]; then
  echo "Error: /twitter-data is empty."
  exit 1
fi

# Run the npm script
npm run start -- --archive-folder /twitter-data