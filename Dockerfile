# Dockerfile to Migrate Twitter Data to Bluesky using
# https://github.com/marcomaroni-github/twitter-to-bluesky

# Sample Docker run
# docker run -v /path/to/twitter-data:/twitter-data \
#            -v /path/to/.env:/twitter-to-bluesky/.env \
#            -e BLUESKY_USERNAME=your_username \
#            -e BLUESKY_PASSWORD=your_password \
#            -e TWITTER_HANDLES=your_handles \
#            twitter-bsky-migraton

FROM library/node:lts-bookworm

# Required environment variables
ENV BLUESKY_USERNAME=isaaclevin.com
ENV BLUESKY_PASSWORD=ihte-3ist-knvc-jq72
ENV TWITTER_HANDLES=isaacrlevin

# Add optional environment variables
ENV SIMULATE=1
ENV MIN_DATE=
ENV MAX_DATE=
ENV DISABLE_IMPORT_REPLY=
ENV API_DELAY=
ENV IGNORE_VIDEO_ERRORS=
ENV VIDEO_UPLOAD_RETRIES=

VOLUME /twitter-data

RUN npm install

COPY /scripts/check_env_and_files.sh /scripts/check_env_and_files.sh
RUN chmod +x /scripts/check_env_and_files.sh

CMD ["bash", "/scripts/check_env_and_files.sh"]