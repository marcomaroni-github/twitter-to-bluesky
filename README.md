# X/Twitter To Bluesky

Import all tweets exported from X/Twitter to a Bluesky account.

They use the official archive export file format from X/Twitter, this utility reads the archive from the local disk and using the official Bluesky Typescript SDK imports the tweets into the configured Bluesky account.

[**An example of an account used to import X/Twitter archive**](https://bsky.app/profile/mm-twitter-archive.bsky.social)

⚠️ We recommend creating a specific account to test the import and not using your main Bluesky account ⚠️

## Which tweets are NOT imported

- Retweets and tweets that start with a quote from another user @ or with RT.

## Prerequisite

- Nodejs >= 20.12x
- The archive of your tweets from the X/Twitter, unzipped in your local disk.

## Breaking changes from version < 0.10

 - PAST_HANDLES parameter has been renamed to TWITTER_HANDLES, It is therefore necessary to update a .env file if it was created before version 0.10

## Getting started

Before everything else, you need to request your Twitter archive. You can do this by following the instructions on the official Twitter support page: [Requesting your Twitter archive](https://help.twitter.com/en/managing-your-account/how-to-download-your-twitter-archive). This process may take a few days, and you will receive an email with a link to download the archive once it's ready.

The program requires the Node.js runtime to be explicitly installed on your machine. You can check if you have it installed by running `node -v` in your terminal/console application. If you don't have it installed,
you can download and install it from the official website: [Node.js](https://nodejs.org/)

Once you have Node.js installed, and if you don't know what `git clone` means (don't go look it up, it's not important), you can download the source code as a zip file from this [GitHub repository](https://github.com/marcomaroni-github/twitter-to-bluesky/releases) and extract it to a folder on your computer. Pick the latest release.

Navigate to the folder where you extracted the source code and open a terminal/console application in that folder. You can do this by typing `cmd` in the address bar of the folder in Windows or by right-clicking in the folder and selecting "Open in Terminal" in MacOS.

In the project folder now run `npm install`. This will download and install all the modules required by the module to run.

## Run the program

You can run the program using command line arguments or environment variables. We recommend using command line arguments to start with, as they are easier to understand and manage.

Mind that the program may have to run for a long time, potentially for several days, if you have a lot of tweets to import. It is recommended to run the program on a computer that you can leave running for a long time without interruptions. Once you hit your daily limit of posts, the program will display the time when the limit resets and wait until your limit is reset before continuing. You can put your computer to sleep while waiting. 

If you have interrupted the program, you can restart it, and it will continue from where it left off. That information is stored in the "tweets_mapping.json" file in the project folder. Don't delete that file unless you want to start the import from scratch or import a different archive.

**We highly recommend trying to simulate the import first and import a small range of tweets, using the additional parameters documented below.**

### Using command line arguments
To start the program, use: `npm run start -- -- [args]` where `[args]` are the arguments you want to pass to the program that are documented below. The double double-dashes may look a bit odd, but they are necessary to pass arguments to the program. (Not our choice, sorry!)

#### Required Arguments
You need to gather your Twitter archive and create a Bluesky account before running the program.

You must provide these arguments for the program to work:

- `--archive-folder <path>` - The folder where your Twitter unzipped archive is stored 
    Example: `--archive-folder "C:\Twitter\archive"`

- `--bluesky-username <username>` - Your Bluesky account name
    Example: `--bluesky-username myname.bsky.social`

- `--bluesky-password <password>` - Your Bluesky account password
    Example: `--bluesky-password mypassword123`

- `--twitter-handles <handles>` - Your previous Twitter usernames (without @), separate multiple names with spaces. You only need to provide multiple handles if you ever changed your Twitter username for the same imported account. It is used to intercept replies to oneself (threads) and filter out some duplicate links included in the tweet text from the tweet archive.
    Example: `--twitter-handles johndoe jane123`

#### Optional Arguments
These arguments are optional and help customize the import:

- `--simulate` - Test the import without actually posting. It is **highly recommended** to use this option first to see how many tweets will be imported and how long it will take.
    Example: `--simulate`

- `--disable-import-reply` - Skip importing tweet replies 
    Example: `--disable-import-reply`

- `--min-date YYYY-MM-DD` - Only import tweets posted after this date
    Example: `--min-date 2020-01-01`

- `--max-date YYYY-MM-DD` - Only import tweets posted before this date
    Example: `--max-date 2023-12-31`

- `--api-delay <milliseconds>` - Wait time between posts in milliseconds (default: 2500)
    Example: `--api-delay 3000`

- `--ignore-video-errors` - Do not stop processing tweets if the video service fails to provide a JobId (typically when the video exceeds the max duration)
    Example: `--ignore-video-errors`

- `--video-upload-retries` - Number of times to retry uploading videos if JOB_STATE_FAILED encountered.
    Example: `--video-upload-retries 5`

**Examples when running on Windows**

Assuming you stored the Twitter archive in `C:\Temp\twitter-archive` and you want to import tweets from two Twitter handles:

``` powershell
npm run start -- -- --archive-folder C:\Temp\twitter-archive --bluesky-username test.bsky.social --bluesky-password pwd123 --twitter-handles sampleuser1 sampleuser2
```

**Examples when running on MacOS or Linux**

Assuming you stored the Twitter archive in your home folder and you want to import tweets from one Twitter handle:

``` bash
npm run start -- -- --archive-folder ~/twitter-archive --bluesky-username test.bsky.social --bluesky-password pwd123 --twitter-handles sampleuser1
```

## Using environment variables
You can also set the required parameters using environment variables or a `.env` file.

Create an .env file in the project folder where you set the following variables or set those in your environment:

- `BLUESKY_USERNAME` = username into which you want to import the tweets (e.g. "test.bsky.social")
- `BLUESKY_PASSWORD` = account password created via App Password (eg. "pwd123")
- `ARCHIVE_FOLDER` = full path to the folder containing the X/Twitter archive (e.g. "C:/Temp/twitter-archive")
- `TWITTER_HANDLES` - one or more x/twitter handles without @, comma separated (e.g. 'marcomaroni,user'). Corresponds to the `--twitter-handles` argument.

Additionally you can set these environment variables to customize behavior:

- `SIMULATE` = if set to "1" simulates the import by counting the tweets and indicating the estimated import time.
- `MIN_DATE` = indicates the minimum date of tweets to import, ISO format (e.g. '2011-01-01' or '2011-02-09T10:30:49.000Z').
- `MAX_DATE` = indicates the maximum date of tweets to import, ISO format (e.g. '2012-01-01' or '2014-04-09T12:36:49.328Z').
- `DISABLE_IMPORT_REPLY` = if set to 1 disables the import of replies to your tweets (threads).
- `API_DELAY` = Delay between Bluesky API calls in milliseconds
- `IGNORE_VIDEO_ERRORS` = if set to "1" continue processing tweets when a video submission fails
- `VIDEO_UPLOAD_RETRIES` = set to the number of times to attempt to upload a video if JOB_STATE_FAILED encountered

**Example of a `.env` file:**

```
BLUESKY_USERNAME=test.bsky.social
BLUESKY_PASSWORD=pwd123
ARCHIVE_FOLDER=C:/Temp/twitter-archive
TWITTER_HANDLES=marcomaroni,user
IGNORE_VIDEO_ERRORS=1
```

Then you can run the script with `npm start` or `npm run start_log` to write an import.log file.

## License
"Twitter To Bluesky" is published under the MIT license.

Copyright 2024 Marco Maroni

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the “Software”), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
