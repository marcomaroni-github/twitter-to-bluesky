# Twitter To Bluesky

Import all tweets exported from Twitter/X to a Bluesky account.

⚠️ This project is a work-in-progress ⚠️

They use the official archive export file format from X/Twitter, this utility reads the archive from the local disk and using the official Bluesky Typescript SDK imports the tweets into the configured Bluesky account.

⚠️ We recommend creating a specific account to test the import and not using your main Bluesky account ⚠️

## Which tweets are not imported

- Retweets and tweets that start with a quote from another user @ or RT.
- Tweets that contain videos, because they are not currently supported by Bluesky

## Prerequisite

Nodejs >= 18.19.0

## Getting started

1. The first step is to obtain the archive of your tweets from the X/Twitter app.
2. Then open the `tweets.js` file in the archive `data` sub folder by changing the first line from `window.YTD.tweets.part0 = [` to `[`, save the file as `twwet.json`.
3. Install Typescript: `npm i -g typescript`
4. Install Node.js: `npm i -g ts-node`
5. Create an .env file in the project folder by setting the following variables:
        BLUESKY_USERNAME = username into which you want to import the tweets (e.g. "test.bsky.social")
        BLUESKY_PASSWORD = account password created via App Password (eg. "pwd123")
        ARCHIVE_FOLDER = full path to the folder containing the X/Twitter archive (e.g. "C:/Temp/twitter-archive")
7. Compile your project by running: `npm run compile`

## Running the script 
1. You can run the script locally: `npm start` or `npm run start_log` to write an import.log file.
