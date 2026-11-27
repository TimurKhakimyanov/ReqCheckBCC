import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/misc'

export function NotFoundPage() {
  const { t } = useTranslation()
  return (
    <EmptyState title={t('common.notFound')}>
      <Button asChild variant="outline">
        <Link to="/documents">{t('nav.documents')}</Link>
      </Button>
    </EmptyState>
  )
}
