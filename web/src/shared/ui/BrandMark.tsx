import iconUrl from '../../assets/mukuroji-icon.svg'

type BrandMarkProps = {
  small?: boolean
}

export function BrandMark({ small = false }: BrandMarkProps) {
  const markSize = small ? 'h-[22px] w-[22px]' : 'h-[38px] w-[38px]'

  return (
    <img
      className={`${markSize} flex-none object-contain drop-shadow-[0_10px_18px_rgba(0,95,231,0.24)]`}
      src={iconUrl}
      alt=""
      aria-hidden="true"
    />
  )
}
