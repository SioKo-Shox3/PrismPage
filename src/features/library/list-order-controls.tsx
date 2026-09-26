import { useId } from 'react'

import { filterOptions, sortOptions, type ReadFilter, type SortKey } from './list-order'
import styles from './list-order.module.css'

// 一覧の並び順と絞り込みを選ぶ欄。値の保持は呼び出し側(並び順は画面ごとに覚える)。

interface ListOrderControlsProps {
  sort: SortKey
  filter: ReadFilter
  onSortChange: (sort: SortKey) => void
  onFilterChange: (filter: ReadFilter) => void
}

export function ListOrderControls({ sort, filter, onSortChange, onFilterChange }: ListOrderControlsProps) {
  const id = useId()
  return (
    <div className={styles.controls} role="group" aria-label="並び替えと絞り込み">
      <label className={styles.field} htmlFor={`${id}-sort`}>
        <span className={styles.label}>並び順</span>
        <select
          id={`${id}-sort`}
          className={styles.select}
          value={sort}
          onChange={(event) => onSortChange(event.target.value as SortKey)}
        >
          {sortOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label className={styles.field} htmlFor={`${id}-filter`}>
        <span className={styles.label}>絞り込み</span>
        <select
          id={`${id}-filter`}
          className={styles.select}
          value={filter}
          onChange={(event) => onFilterChange(event.target.value as ReadFilter)}
        >
          {filterOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}
