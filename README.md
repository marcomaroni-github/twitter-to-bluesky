# X/Twitter To Bluesky

Import all tweets exported from X/Twitter to a Bluesky account.

⚠️ This project is a work-in-progress ⚠️

They use the official archive export file format from X/Twitter, this utility reads the archive from the local disk and using the official Bluesky Typescript SDK imports the tweets into the configured Bluesky account.

⚠️ We recommend creating a specific account to test the import and not using your main Bluesky account ⚠️

## Which tweets are NOT imported

- Retweets and tweets that start with a quote from another user @ or with RT.
- Tweets that contain videos, because they are not currently supported by Bluesky.

## Prerequisite

- Nodejs >= 18.19.0
- The archive of your tweets from the X/Twitter.

## Getting started

1. Install Typescript: `npm i -g typescript`
2. Install Node.js: `npm i -g ts-node`
3. Create an .env file in the project folder by setting the following variables:
        `BLUESKY_USERNAME` = username into which you want to import the tweets (e.g. "test.bsky.social")
        `BLUESKY_PASSWORD` = account password created via App Password (eg. "pwd123")
        `ARCHIVE_FOLDER` = full path to the folder containing the X/Twitter archive (e.g. "C:/Temp/twitter-archive")

**I highly recommend trying to simulate the import first and import a small range of tweets, using the additional parameters documented below.**

## Running the script 

You can run the script locally: `npm start` or `npm run start_log` to write an import.log file.

### Optional environment parameters

Additionally you can set these environment variables to customize behavior:

`SIMULATE` = if set to "1" simulates the import by counting the tweets and indicating the estimated import time.
`MIN_DATE` = indicates the minimum date of tweets to import, ISO format (e.g. '2011-01-01' or '2011-02-09T10:30:49.000Z').
`MAX_DATE` = indicates the maximum date of tweets to import, ISO format (e.g. '2012-01-01' or '2014-04-09T12:36:49.328Z').

## License

"Twitter To Bluesky" is published under the MIT license.

Copyright 2024 Marco Maroni

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the “Software”), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.