/**
 * English messages for the auth domain.
 */
export const authMessages = {
  'login.title': 'Log in',
  'login.subtitle': 'Sign in to your account',
  'login.emailFirstSubtitle':
    'We’ll find the secure sign-in method for your work email',
  'login.passwordSubtitle': 'Enter your password to continue',
  'login.email': 'Email address',
  'login.emailPlaceholder': 'Enter your email address',
  'login.discoveryHelp':
    'For managed domains, you’ll continue to your organization’s SSO without sending a password.',
  'login.changeEmail': 'Change',
  'login.continue': 'Continue',
  'login.continuing': 'Checking sign-in method',
  'login.password': 'Password',
  'login.passwordPlaceholder': 'Enter your password',
  'login.showPassword': 'Show password',
  'login.hidePassword': 'Hide password',
  'login.remember': 'Keep me signed in',
  'login.submit': 'Log in',
  'login.loading': 'Logging in',
  'login.errorInvalid': 'The email address or password is incorrect.',
  'login.errorUnavailable':
    'Local Cognito is not ready yet. Check the Floci service status.',
  'login.errorUnknown': 'Login failed. Please try again later.',
  'login.errorSso':
    'Single sign-on could not be started. Please try again later.',
  'login.ssoCallback.title': 'Completing single sign-on',
  'login.ssoCallback.description':
    'Securely validating the authentication response. Keep this page open.',
  'login.ssoCallback.errorTitle': 'Single sign-on could not be completed',
  'login.ssoCallback.errorDescription':
    'The authentication request expired or could not be verified. Start again from the login page.',
  'login.ssoCallback.retry': 'Return to login',
  'login.forgotPassword': 'Forgot your password?',
  'login.challenge.title': 'Set a new password',
  'login.challenge.subtitle': 'Complete your first sign-in',
  'login.challenge.account': 'Update the first-time password for {email}.',
  'login.challenge.newPassword': 'New password',
  'login.challenge.newPasswordPlaceholder': 'Enter a new password',
  'login.challenge.confirmPassword': 'Confirm new password',
  'login.challenge.confirmPasswordPlaceholder': 'Enter it again',
  'login.challenge.passwordHint':
    'Use at least 8 characters and follow your organization’s password policy.',
  'login.challenge.submit': 'Set password and continue',
  'login.challenge.loading': 'Setting password',
  'login.challenge.backToLogin': 'Back to regular login',
  'login.challenge.errorMismatch': 'The confirmation password does not match.',
  'login.challenge.errorPasswordPolicy':
    'The new password does not meet your organization’s password policy. Review the requirements and try again.',
  'login.challenge.errorExpired':
    'The first-sign-in session expired. Start again from regular login.',
  'login.challenge.errorUnavailable':
    'Authentication or workspace provisioning is unavailable. Return to regular login and try again later.',
  'login.challenge.error':
    'First sign-in could not be completed. Your new password may already have been saved.',
  'login.challenge.retryTitle': 'You can resume from regular login',
  'login.challenge.retryDescription':
    'If Cognito saved the new password but the workspace update failed, enter the same email address and new password on regular login to resume recovery.',
  'login.mfa.title': 'Enter your verification code',
  'login.mfa.subtitle': 'Complete multi-factor authentication',
  'login.mfa.verifyTitle': 'Identity verification required',
  'login.mfa.authenticatorDescription':
    'Enter the verification code shown in your authenticator app.',
  'login.mfa.codeDescription':
    'Enter the verification code sent through your registered authentication method.',
  'login.mfa.deliveryDescription':
    'Enter the verification code sent to {destination}.',
  'login.mfa.code': 'Verification code',
  'login.mfa.codePlaceholder': '6–8 digit code',
  'login.mfa.codeHelp':
    'Use digits only. Verification codes and challenge sessions are not saved in the browser.',
  'login.mfa.verify': 'Verify and log in',
  'login.mfa.verifying': 'Verifying',
  'login.mfa.restart': 'Start again with email',
  'login.mfa.errorCode': 'Enter a 6–8 digit verification code.',
  'login.mfa.errorInvalid':
    'The code is incorrect or expired. Check for a newer verification code.',
  'login.mfa.errorExpired':
    'The verification session expired. Start the login again with your email.',
  'login.mfa.errorRateLimited':
    'Too many verification attempts. Wait before starting again.',
  'login.mfa.errorUnavailable':
    'The verification service is unavailable. Try again later.',
  'login.mfa.errorUnknown':
    'Verification could not be completed. Check the code and try again.',
} as const
