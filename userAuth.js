'use strict'

const passport = require('passport')
const session = require('express-session')
const crypto = require('crypto')
const GoogleStrategy = require('passport-google-oauth20')
const SlackStrategy = require('passport-slack-oauth2').Strategy

const {getAuth} = require('../server/auth')
const {Datastore} = require('@google-cloud/datastore')
const {DatastoreStore} = require('@google-cloud/connect-datastore')

const log = require('../server/logger')
const {stringTemplate: template} = require('../server/utils')

const router = require('express-promise-router')()
const domains = new Set(process.env.APPROVED_DOMAINS.split(/,\s?/g))

log.info('Using custom userAuth')

const authStrategies = ['google', 'Slack']
let authStrategy = process.env.OAUTH_STRATEGY

const callbackURL = process.env.REDIRECT_URL || '/auth/redirect'
if (!authStrategies.includes(authStrategy)) {
  log.warn(`Invalid oauth strategy ${authStrategy} specific, defaulting to google auth`)
  authStrategy = 'google'
}

const isSlackOauth = authStrategy === 'Slack'
if (isSlackOauth) {
  passport.use(new SlackStrategy({
    clientID: process.env.SLACK_CLIENT_ID,
    clientSecret: process.env.SLACK_CLIENT_SECRET,
    skipUserProfile: false,
    callbackURL,
    scope: ['identity.basic', 'identity.email', 'identity.avatar', 'identity.team', 'identity.email']
  },
  (accessToken, refreshToken, profile, done) => {
    // optionally persist user data into a database
    done(null, profile)
  }
  ))
} else {
  // default to google auth
  passport.use(new GoogleStrategy.Strategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL,
    userProfileURL: 'https://www.googleapis.com/oauth2/v3/userinfo',
    passReqToCallback: true
  }, (request, accessToken, refreshToken, profile, done) => done(null, profile)))
}

const md5 = (data) => crypto.createHash('md5').update(data).digest('hex')

async function getDatastoreClient() {
  const projectId = process.env.GCP_PROJECT_ID
  if (!projectId) {
    log.warn('No GCP_PROJECT_ID provided! Will not connect to GCloud Datastore!')
    return null
  }

  // because auth credentials may be passed in multiple ways, recycle pathway used by main auth logic
  const {email, key} = await getAuth()

  return new Datastore({
    projectId,
    credentials: {
      client_email: email,
      private_key: key
    }
  })
}

router.use(async (req, res, next) => {
  try {
    const datastoreClient = await getDatastoreClient()
    // Set cookie to outlive session so datastore cleans up expired sessions
    // https://github.com/googleapis/nodejs-datastore-session/pull/134
    const serverExpiration = 1000 * 60 * 60 * 24 * 7
    const cookieExpiration = 1000 * 60 * 60 * 24 * 365
  
    const datastoreSession = session({
      store: new DatastoreStore({
        kind: 'express-sessions',
        dataset: datastoreClient,
        expirationMs: serverExpiration
      }),
      cookie: {
        maxAge: cookieExpiration,
        sameSite: 'lax',
        httpOnly: true
      },
      secret: process.env.SESSION_SECRET,
      resave: true,
      rolling: true,
      saveUninitialized: false
    })
  
    datastoreSession(req, res, next)
  } catch (err) {
    log.warn('Failed to load datastore')
    // Default to MemoryStore if datastore can't be loaded
    const memoryStoreSession = session({
      secret: process.env.SESSION_SECRET,
      resave: true,
      saveUninitialized: true
    })

    memoryStoreSession(req, res, next)
  }
})

router.use(passport.initialize())
router.use(passport.session())

// seralize/deseralization methods for extracting user information from the
// session cookie and adding it to the req.passport object
passport.serializeUser((user, done) => done(null, user))
passport.deserializeUser((obj, done) => done(null, obj))

const googleLoginOptions = {
  scope: [
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile'
  ],
  prompt: 'select_account'
}

router.get('/login', passport.authenticate(authStrategy, isSlackOauth ? {} : googleLoginOptions))

router.get('/logout', (req, res) => {
  req.logout()
  res.redirect('/')
})

router.get('/auth/redirect', passport.authenticate(authStrategy, {failureRedirect: '/login'}), (req, res) => {
  res.redirect(req.session.authRedirect || '/')
})

router.use((req, res, next) => {
  const isDev = process.env.NODE_ENV === 'development'
  const passportUser = (req.session.passport || {}).user || {}
  if (isDev || (req.isAuthenticated() && isAuthorized(passportUser))) {
    setUserInfo(req)
    return next()
  }

  if (req.isAuthenticated() && !isAuthorized(passportUser)) {
    return next(Error('Unauthorized'))
  }

  log.info('User not authenticated')
  req.session.authRedirect = req.path
  res.redirect('/login')
})

function isAuthorized(user) {
  const [{value: userEmail = ''} = {}] = user.emails || []
  const [userDomain] = userEmail.split('@').slice(-1)
  const checkRegexEmail = () => {
    const domainsArray = Array.from(domains)
    for (const domain of domainsArray) {
      if (userDomain.match(domain)) return true
    }
  }
  return domains.has(userDomain) || domains.has(userEmail) || checkRegexEmail()
}

function setUserInfo(req) {
  if (process.env.NODE_ENV === 'development') {
    req.userInfo = {
      email: process.env.TEST_EMAIL || template('footer.defaultEmail'),
      userId: '10',
      analyticsUserId: md5('10library')
    }
    return
  }
  const email = isSlackOauth ? req.session.passport.user.email : req.session.passport.user.emails[0].value
  req.userInfo = req.userInfo ? req.userInfo : {
    userId: req.session.passport.user.id,
    analyticsUserId: md5(req.session.passport.user.id + 'library'),
    email
  }
}

module.exports = router
