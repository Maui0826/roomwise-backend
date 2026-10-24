import { Router } from 'express';
import { requireAuth, optionalAuth } from '../../middleware/authentication.js';
import {
  requireCsrfWhenAuthenticated,
  validateRequestOrigin,
} from '../../middleware/csrf.js';
import { validateBody } from '../../middleware/validate-body.js';
import {
  loginAccountRateLimit,
  loginIpRateLimit,
  googleLoginRateLimit,
  signupRateLimit,
} from './auth.rate-limits.js';
import {
  login,
  logout,
  currentUser,
  csrfToken,
  googleLogin,
  signup,
} from './auth.controller.js';
import {
  googleLoginSchema,
  loginSchema,
  signupSchema,
} from './auth.schemas.js';

export const authRouter = Router();

authRouter.post(
  '/signup',
  signupRateLimit,
  validateRequestOrigin,
  validateBody(signupSchema),
  signup,
);
authRouter.post(
  '/login',
  loginIpRateLimit,
  loginAccountRateLimit,
  validateRequestOrigin,
  validateBody(loginSchema),
  login,
);
authRouter.post(
  '/google',
  googleLoginRateLimit,
  validateRequestOrigin,
  validateBody(googleLoginSchema),
  googleLogin,
);
authRouter.post(
  '/logout',
  validateRequestOrigin,
  optionalAuth,
  requireCsrfWhenAuthenticated,
  logout,
);
authRouter.get('/me', requireAuth, currentUser);
authRouter.get('/csrf', requireAuth, csrfToken);
