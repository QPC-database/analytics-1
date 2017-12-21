const dotenv = require('dotenv');
const google = require('googleapis');
const moment = require('moment');
const { stripIndents } = require('common-tags');
const {
  differenceWith,
  head,
  isEqual,
  orderBy,
  partition,
  sumBy
} = require('lodash');

dotenv.config();

const VIEW_ID = process.env.VIEW_ID;
const credentials = require('./credentials.json');
const liveRoutes = require(`${
  process.env.APP_DIR
}/config/cloudfront/live.json`);

const analytics = google.analytics('v3');

const argv = require('yargs')
  .describe('start', 'Supply a date to start the lookup from (YYYY-MM-DD)')
  .alias('s', 'start')
  .describe('end', 'Supply a date to end the lookup from (YYYY-MM-DD)')
  .alias('e', 'end')
  .describe('percentage', 'target percentage of traffic to react')
  .describe('csv', 'Write results to a CSV')
  .help('h')
  .alias('h', 'help').argv;

const startDate =
  argv.start && moment(argv.start, 'YYYY-MM-DD').isValid() ? argv.start : '30daysAgo';
const endDate =
  argv.end && moment(argv.end, 'YYYY-MM-DD').isValid() ? argv.end : 'yesterday';
const targetPercentage = argv.percentage ? parseInt(argv.percentage, 10) : 80;

function queryData(query) {
  return new Promise((resolve, reject) => {
    analytics.data.ga.get(query, function(err, response) {
      if (err) {
        reject(err);
      }
      resolve(response);
    });
  });
}

function fullUrl(urlPath) {
  return `https://www.biglotteryfund.org.uk${encodeURI(urlPath)}`;
}

function processQueryRows(queryRows) {
  const cleanedRows = queryRows.map(row => {
    const [fullUrl, pageviews] = row;

    return {
      fullUrl: fullUrl,
      cleanUrl:
        fullUrl.indexOf('/~/link.aspx') !== -1
          ? fullUrl
          : head(fullUrl.split('?')),
      pageviews: parseInt(pageviews, 10)
    };
  });

  const combinedRows = cleanedRows.reduce((collection, currentRow) => {
    const match = collection.find(row => row.cleanUrl === currentRow.cleanUrl);
    if (match) {
      match.pageviews = match.pageviews + currentRow.pageviews;
    } else {
      collection.push(currentRow);
    }
    return collection;
  }, []);

  return orderBy(combinedRows, ['pageviews'], ['desc']);
}

function limitUpToPercentage({ results, targetPercentage, totalPageViews }) {
  let count = 0;
  return results.filter(u => {
    count += u.pageviews;
    const pageviewsRequiredForTarget = totalPageViews / 100 * targetPercentage;
    return count < pageviewsRequiredForTarget;
  });
}

function analyse({ queryRows, targetPercentage, totalPageViews }) {
  const allResults = processQueryRows(queryRows);

  const resultsUpToTarget = limitUpToPercentage({
    results: allResults,
    targetPercentage: targetPercentage,
    totalPageViews: totalPageViews
  });

  const [replacedPages, pagesToReplace] = partition(resultsUpToTarget, row => {
    const livePaths = liveRoutes.map(route =>
      route.PathPattern.replace('*', '')
    );
    return livePaths.indexOf(row.cleanUrl.toLowerCase()) !== -1;
  });

  const replacedTotalPageviews = sumBy(replacedPages, 'pageviews');

  const replacedPercentage = Math.round(
    replacedTotalPageviews / totalPageViews * 100
  );

  return {
    allResults,
    replacedPages,
    replacedTotalPageviews,
    replacedPercentage,
    pagesToReplace,
    totalPageViews,
    targetPercentage
  };
}

function summarise(analysis) {
  console.log('');
  console.log(stripIndents`
    Using stats from: ${startDate} - ${endDate}

    Here are the pages we have yet to replace, which will get us to ${
      analysis.targetPercentage
    }%:

    ${analysis.pagesToReplace
      .map(
        (row, i) =>
          `${i + 1}. ${fullUrl(row.cleanUrl)} (${row.pageviews} pageviews)`
      )
      .join('\n')}

    There are ${analysis.allResults.length} unique URLs accessed in this period.
    This covers ${analysis.totalPageViews} total pageviews.
    If we want to reach ${
      analysis.targetPercentage
    }% of pageviews, we need to replace ${analysis.pagesToReplace.length} pages.
    We have already replaced ${
      analysis.replacedPages.length
    } pages, which gets us to ${analysis.replacedPercentage}% already.
  `);
}

function writeCsv(pagesToReplace) {
  const csv = require('fast-csv');
  csv
    .writeToPath(
      'results.csv',
      pagesToReplace.map(row => {
        return [fullUrl(row.cleanUrl), row.pageviews];
      })
    )
    .on('finish', function() {
      console.log('Results written to CSV');
    });
}

const jwtClient = new google.auth.JWT(
  credentials.client_email,
  null,
  credentials.private_key,
  ['https://www.googleapis.com/auth/analytics.readonly'],
  null
);

jwtClient.authorize(function(err, tokens) {
  if (err) {
    console.log(err);
    return;
  }

  queryData({
    auth: jwtClient,
    ids: VIEW_ID,
    metrics: 'ga:uniquePageviews',
    dimensions: 'ga:pagePath',
    'start-date': startDate,
    'end-date': endDate,
    sort: '-ga:uniquePageviews',
    filters: 'ga:pagePath!@.pdf',
    'max-results': 10000
  })
    .then(data => {
      const analysis = analyse({
        queryRows: data.rows,
        targetPercentage: targetPercentage,
        totalPageViews: parseInt(
          data.totalsForAllResults['ga:uniquePageviews'],
          10
        )
      });

      summarise(analysis);

      if (argv.csv) {
        writeCsv(analysis.pagesToReplace);
      }
    })
    .catch(err => console.log(err));
});
