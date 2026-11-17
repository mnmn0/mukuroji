import { useState, type FormEvent } from 'react'
import { ApiError, confirmPasswordReset, requestPasswordReset } from '../../../auth/api'
import type { MessageKey } from '../../../shared/i18n/i18n'
import { isValidEmailAddress } from '../../../shared/lib/publicPage'

/**
 * Step of the password reset flow.
 *
 * - `request`: enter the email address and send a code
 * - `confirm`: enter the emailed code and a new password
 * - `done`: the password is reset
 */
export type PasswordResetStep = 'request' | 'confirm' | 'done'

/** Initial state of {@link usePasswordRecovery}. */
export type PasswordRecoveryOptions = {
  /** Email address to start with. */
  initialEmail: string
  /** Step to start with. */
  initialStep: PasswordResetStep
}

/**
 * Maps a failed reset call to a message.
 *
 * @param error - Error from the API.
 * @returns The message key.
 */
function resolvePasswordResetErrorKey(error: unknown): MessageKey {
  if (!(error instanceof ApiError)) return 'passwordReset.error.unavailable'
  if (error.code === 'PasswordResetCodeInvalid') return 'passwordReset.error.codeInvalid'
  if (error.code === 'InvalidNewPassword') return 'passwordReset.error.passwordPolicy'
  if (error.code === 'SsoRequired') return 'passwordReset.error.sso'
  if (error.code === 'AccountSecurityRateLimited' || error.status === 429) {
    return 'passwordReset.error.rateLimited'
  }
  if (error.code === 'InvalidPasswordResetRequest') return 'passwordReset.emailError'
  return 'passwordReset.error.unavailable'
}

/**
 * Owns the forgotten-password flow: sending the emailed code, checking the input, and setting
 * the new password, with the step, submission state, and error message the form shows.
 *
 * @param options - Email address and step to start with.
 * @returns The form state and actions.
 */
export function usePasswordRecovery({ initialEmail, initialStep }: PasswordRecoveryOptions) {
  const [email, setEmailValue] = useState(initialEmail)
  const [step, setStep] = useState<PasswordResetStep>(initialStep)
  const [codeSent, setCodeSent] = useState(false)
  const [code, setCodeValue] = useState('')
  const [newPassword, setNewPasswordValue] = useState('')
  const [newPasswordConfirmation, setNewPasswordConfirmationValue] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [errorKey, setErrorKey] = useState<MessageKey | undefined>()

  /** Sends a reset code to the entered address. */
  const sendCode = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault()
    if (isSubmitting) return
    const normalizedEmail = email.trim().toLowerCase()
    if (!isValidEmailAddress(normalizedEmail)) {
      setErrorKey('passwordReset.emailError')
      return
    }
    setIsSubmitting(true)
    setErrorKey(undefined)
    try {
      await requestPasswordReset(normalizedEmail)
      setEmailValue(normalizedEmail)
      setCodeSent(true)
      setCodeValue('')
      setStep('confirm')
    } catch (error) {
      setErrorKey(resolvePasswordResetErrorKey(error))
    } finally {
      setIsSubmitting(false)
    }
  }

  /** Sets the new password with the emailed code. */
  const confirm = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (isSubmitting) return
    if (!/^\d{6,8}$/u.test(code)) {
      setErrorKey('passwordReset.codeError')
      return
    }
    if (!newPassword) {
      setErrorKey('passwordReset.error.passwordPolicy')
      return
    }
    if (newPassword !== newPasswordConfirmation) {
      setErrorKey('passwordReset.mismatch')
      return
    }
    setIsSubmitting(true)
    setErrorKey(undefined)
    try {
      await confirmPasswordReset({
        email: email.trim().toLowerCase(),
        code,
        newPassword,
      })
      setNewPasswordValue('')
      setNewPasswordConfirmationValue('')
      setCodeValue('')
      setStep('done')
    } catch (error) {
      setErrorKey(resolvePasswordResetErrorKey(error))
    } finally {
      setIsSubmitting(false)
    }
  }

  return {
    email,
    step,
    codeSent,
    code,
    newPassword,
    newPasswordConfirmation,
    isSubmitting,
    errorKey,
    sendCode,
    confirm,
    /** Updates the email address and clears the error. */
    setEmail(value: string) {
      setEmailValue(value)
      setErrorKey(undefined)
    },
    /** Updates the code, keeping at most eight digits, and clears the error. */
    setCode(value: string) {
      setCodeValue(value.replace(/\D/gu, '').slice(0, 8))
      setErrorKey(undefined)
    },
    /** Updates the new password and clears the error. */
    setNewPassword(value: string) {
      setNewPasswordValue(value)
      setErrorKey(undefined)
    },
    /** Updates the password confirmation and clears the error. */
    setNewPasswordConfirmation(value: string) {
      setNewPasswordConfirmationValue(value)
      setErrorKey(undefined)
    },
    /** Goes back to the first step to enter another address. */
    editEmail() {
      setStep('request')
      setCodeSent(false)
      setErrorKey(undefined)
    },
  }
}
