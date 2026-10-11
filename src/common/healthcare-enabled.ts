import { CanActivate, Injectable, NotFoundException } from '@nestjs/common'

/**
 * Buy Medicine (Nigeria pharmacy orders) is off unless HEALTHCARE_ENABLED=true. Must match
 * the frontend's NEXT_PUBLIC_HEALTHCARE_ENABLED, which hides the tab and page.
 */
export function isHealthcareEnabled(): boolean {
  return process.env.HEALTHCARE_ENABLED === 'true'
}

/** 404s every route on a healthcare controller while the feature is off. */
@Injectable()
export class HealthcareEnabledGuard implements CanActivate {
  canActivate(): boolean {
    if (!isHealthcareEnabled()) throw new NotFoundException()
    return true
  }
}
