import type { ReactNode } from 'react';
import { Label, Tag, TagGroup } from '@heroui/react';

export interface FilterTagOptionV1 {
  readonly id: string;
  readonly label: string;
  readonly icon?: ReactNode;
}

/** One group of filter tags, the same in every module. Empty selection means unrestricted
 * unless `single`, where exactly one option stays chosen (an order, a view). */
export function FilterTagsV1({
  label,
  selected,
  options,
  onChange,
  single = false,
  inline = false,
  className = '',
}: Readonly<{
  label: string;
  selected: ReadonlySet<string>;
  options: readonly FilterTagOptionV1[];
  onChange: (keys: Set<string>) => void;
  single?: boolean;
  /** Label beside the tags instead of above them. */
  inline?: boolean;
  className?: string;
}>) {
  return (
    <TagGroup
      selectionMode={single ? 'single' : 'multiple'}
      disallowEmptySelection={single}
      selectedKeys={selected as Set<string>}
      size="sm"
      className={`filter-tags-v1${inline ? ' filter-tags-v1--inline' : ''}${className ? ` ${className}` : ''}`}
      onSelectionChange={(keys) => {
        const allowed = new Set(options.map((item) => item.id));
        onChange(
          new Set(
            keys === 'all' ? allowed : [...keys].map(String).filter((key) => allowed.has(key)),
          ),
        );
      }}
    >
      <Label>{label}</Label>
      <TagGroup.List>
        {options.map((item) => (
          <Tag key={item.id} id={item.id} textValue={item.label}>
            {item.icon}
            <span>{item.label}</span>
          </Tag>
        ))}
      </TagGroup.List>
    </TagGroup>
  );
}
